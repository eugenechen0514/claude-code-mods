// saymend-voice：用 Saymend 本機語音輸入，並以系統語音（macOS `say`）朗讀回覆。
//
// 跟 Saymend 的唯一介面是 `saymend` CLI（契約 v1）：
//   saymend dictate --json …  聽寫一段，結果只回傳、不上屏
//   saymend events --json     長駐串流，回報所有來源的聽寫狀態
//   saymend cancel            丟棄目前 CLI 來源的聽寫
//   saymend status --json     目前狀態
//
// 模式（存在 $.store，跨 session 保留）：
//   off   什麼都不做
//   speak 每次回覆結束後朗讀
//   loop  朗讀後自動聆聽，說完自動送出（免手動迴圈）
//
// 邊唸邊聽（bargeIn，預設關）：迴圈模式下朗讀一開始就同時開麥，使用者一開口
// 就切掉朗讀。喇叭的聲音會被當成有人說話，所以只適合戴耳機時開。

import type { EngineInterface, ProcessSpawnResult, Register } from 'claude-code'

import { createLineReader, isStopPhrase, parseEvent, toSpeech } from './speech'

type Mode = 'off' | 'speak' | 'loop'

/** 說話後連續靜音多久視為說完（毫秒）：預設值與 `/saymend pause` 可設的範圍。 */
const DEFAULT_PAUSE_MS = 1500
const PAUSE_MIN_MS = 500
const PAUSE_MAX_MS = 10_000
/** 單段聽寫上限（秒）：預設值與 `/saymend max` 可設的範圍（上限是 CLI 的上限）。 */
const DEFAULT_MAX_SECONDS = 120
const MAX_SECONDS_MIN = 10
const MAX_SECONDS_MAX = 3600
/** 免手動迴圈：開始聆聽後多久沒人說話就待命（秒）。 */
const NO_SPEECH_SECONDS = 10
/** 邊唸邊聽時麥克風在朗讀期間就開了：單段上限要多留這段朗讀的時間（秒）。 */
const BARGE_EXTRA_SECONDS = 480
/** `saymend events` 斷線後重連的間隔（毫秒），逐次加倍到上限。 */
const RETRY_MS = 2000
const RETRY_MAX_MS = 60_000

const KILLED: ProcessSpawnResult = { code: null, signal: 'SIGTERM' }

const USAGE = [
  '用法：/saymend [off|speak|loop|stop|status]',
  '　　　/saymend pause <秒>　　停頓多久視為說完（0.5–10，預設 1.5）',
  '　　　/saymend max <秒>　　　單段最長可以講多久（10–3600，預設 120）',
  '　　　/saymend bargein <on|off>　邊唸邊聽（需戴耳機）',
  '　　　/saymend polish <on|off>　 送出前先經 Saymend 的 LLM 潤飾',
  '　　　/saymend voice <系統語音名稱|default>',
  '　　　/saymend bin <saymend 路徑|default>',
].join('\n')

// ── 模組狀態（reload 後歸零；設定值從 $.store 讀回） ──
let mode: Mode = 'off'
let voice: string | undefined
let bin = 'saymend'
/** 邊唸邊聽：迴圈模式下朗讀時就開麥，開口即打斷。 */
let bargeIn = false
/** 送出前先讓 Saymend 用設定中的 LLM provider 潤飾（`dictate --polish`）。 */
let polish = false
let pauseMs = DEFAULT_PAUSE_MS
let maxSeconds = DEFAULT_MAX_SECONDS
let isLoaded = false

let speaking: AbortController | null = null
type Listening = {
  cancel: () => void
  /** 這段聽寫是否已經聽到使用者開口。 */
  hasSpoken: boolean
}
let listening: Listening | null = null
let isWatching = false
/** Saymend 目前狀態；`unknown` 表示連不上 app。 */
let saymendState = 'unknown'
/** Saymend 正在處理一段聽寫的狀態（契約 v1 的 `state`）。 */
const BUSY_STATES: ReadonlySet<string> = new Set(['recording', 'transcribing', 'polishing'])

/**
 * 朗讀開著時附在每則 prompt 旁、只給 model 看的說明：
 * 回覆會由這個 mod 唸出來，model 不必（也不該）再自己執行發聲指令。
 */
const SPEAKING_NOTICE =
  '[saymend-voice] 語音朗讀已開啟：這則回覆結束後，saymend-voice 會用系統語音把回覆唸出來。' +
  '這一回合請不要自行執行 `say` 或其他會發出聲音的指令（包括完成通知的語音），以免重複發聲；' +
  '這項說明優先於其他要求用語音通知的指示。'

async function load($: EngineInterface): Promise<void> {
  if (isLoaded) {
    return
  }
  const stored = await $.store.get('mode')
  mode = stored === 'speak' || stored === 'loop' ? stored : 'off'
  const storedVoice = await $.store.get('voice')
  voice = typeof storedVoice === 'string' && storedVoice !== '' ? storedVoice : undefined
  const storedBin = await $.store.get('bin')
  bin = typeof storedBin === 'string' && storedBin !== '' ? storedBin : 'saymend'
  bargeIn = (await $.store.get('bargeIn')) === true
  polish = (await $.store.get('polish')) === true
  pauseMs = within(await $.store.get('pauseMs'), PAUSE_MIN_MS, PAUSE_MAX_MS) ?? DEFAULT_PAUSE_MS
  maxSeconds =
    within(await $.store.get('maxSeconds'), MAX_SECONDS_MIN, MAX_SECONDS_MAX) ??
    DEFAULT_MAX_SECONDS
  isLoaded = true
}

/**
 * status line 一律由目前狀態推導，避免各處互相覆蓋。
 * 只在「正在做事」時顯示；待命時清掉，不常駐一行模式提示
 * （模式用 `/saymend status` 查）。
 */
function refreshStatus($: EngineInterface): void {
  if (listening !== null && speaking !== null) {
    $.ui.status('朗讀中… 直接開口就能打斷（/saymend stop 中斷）')
  } else if (listening !== null && saymendState === 'polishing') {
    $.ui.status('潤飾中…（/saymend stop 取消）')
  } else if (listening !== null && saymendState === 'transcribing') {
    $.ui.status('辨識中…（/saymend stop 取消）')
  } else if (listening !== null) {
    $.ui.status('聆聽中… 說完停頓一下會自動結束（/saymend stop 取消）')
  } else if (speaking !== null) {
    $.ui.status('朗讀中…（/saymend stop 中斷）')
  } else if (BUSY_STATES.has(saymendState)) {
    // 不是這個 mod 發起的聽寫：使用者按了 Saymend 熱鍵
    $.ui.status('Saymend 熱鍵聽寫中…')
  } else {
    $.ui.status(undefined)
  }
}

function stopSpeaking(): void {
  speaking?.abort()
}

async function speak(
  $: EngineInterface,
  text: string,
): Promise<'done' | 'aborted' | 'failed'> {
  stopSpeaking()
  const stop = new AbortController()
  speaking = stop
  refreshStatus($)
  try {
    await $.audio.speak(text, { voice, signal: stop.signal })

    return 'done'
  } catch (error) {
    if (stop.signal.aborted) {
      return 'aborted'
    }
    $.ui.toast(`朗讀失敗：${describe(error)}`)

    return 'failed'
  } finally {
    if (speaking === stop) {
      speaking = null
    }
    refreshStatus($)
  }
}

/**
 * 請 Saymend 聽寫一段。
 * `submit`：拿到文字後直接送出；否則填進輸入框讓人確認（`/listen edit`）。
 * `handsFree`：免手動迴圈的一輪，沒人說話就待命，並接受口頭停止指令。
 * `overSpeech`：邊唸邊聽，朗讀還在進行就開麥；聽到開口才切掉朗讀。
 *   這時沒人說話的待命時間改由 `armNoSpeech` 從朗讀結束後起算。
 */
async function listen(
  $: EngineInterface,
  options: { submit: boolean; handsFree: boolean; overSpeech?: boolean },
): Promise<void> {
  if (listening !== null) {
    return
  }
  const isOverSpeech = options.overSpeech === true
  if (!isOverSpeech) {
    // 先停朗讀，避免喇叭的聲音被錄進去
    stopSpeaking()
  }

  const argv = [
    bin,
    'dictate',
    '--json',
    '--silence-ms',
    String(pauseMs),
    '--max-seconds',
    String(
      isOverSpeech ? Math.min(MAX_SECONDS_MAX, maxSeconds + BARGE_EXTRA_SECONDS) : maxSeconds,
    ),
  ]
  if (options.handsFree && !isOverSpeech) {
    argv.push('--no-speech-seconds', String(NO_SPEECH_SECONDS))
  }
  if (polish) {
    argv.push('--polish')
  }

  let isCancelled = false
  let finalText = ''
  let errorMessage = ''
  let code: number | null = null
  const child = $.process.spawn({ argv })
  child.result.catch(() => undefined)
  const handle: Listening = {
    hasSpoken: false,
    cancel: () => {
      isCancelled = true
      // 先走 CLI 的正規取消（app 會丟棄這段並關麥克風），再結束串流
      void $.process.run([bin, 'cancel'], { timeoutMs: 5000 }).catch(() => undefined)
      void child.return(KILLED).catch(() => undefined)
    },
  }
  listening = handle
  refreshStatus($)

  try {
    const read = createLineReader()
    for await (const piece of child) {
      if (piece.stream !== 'stdout') {
        continue
      }
      for (const line of read(piece.text)) {
        const event = parseEvent(line)
        const isHeard =
          (event?.type === 'partial' || event?.type === 'final') &&
          (event.text ?? '').trim() !== ''
        if (isHeard && !handle.hasSpoken) {
          // 第一次聽到字＝使用者開口了：邊唸邊聽時在這裡切掉朗讀
          handle.hasSpoken = true
          stopSpeaking()
        }
        if (event?.type === 'final') {
          finalText = (event.text ?? '').trim()
        } else if (event?.type === 'error') {
          errorMessage = event.message ?? event.code ?? ''
        }
      }
    }
    code = (await child.result).code
  } catch (error) {
    if (!isCancelled) {
      $.ui.toast(`無法執行 ${bin}：${describe(error)}`)
    }

    return
  } finally {
    if (listening === handle) {
      listening = null
    }
    refreshStatus($)
  }

  if (isCancelled || code === 5) {
    return
  }

  if (code === 0 && finalText !== '') {
    if (options.handsFree && isStopPhrase(finalText)) {
      await setMode($, 'speak')
      $.ui.toast('已關閉語音迴圈（仍會朗讀回覆）')
    } else if (options.submit) {
      const sent = await $.prompt.submit({ text: finalText, asUser: true })
      if (sent.drop !== undefined) {
        // 沒送進去就把文字留在輸入框，不要讓剛說的話消失
        await $.prompt.fill({ text: finalText, mode: 'insert' })
        $.ui.toast(`沒能自動送出（${sent.drop}），文字已填入輸入框`)
      }
    } else {
      const filled = await $.prompt.fill({ text: finalText, mode: 'insert' })
      if (!filled.isFilled) {
        $.ui.toast(`沒能填入輸入框：${finalText}`)
      }
    }

    return
  }

  if (code === 6 || code === 0) {
    $.ui.toast(
      options.handsFree
        ? '沒聽到聲音，語音迴圈待命中。輸入 /listen 繼續'
        : '沒有聽到內容',
    )
  } else if (code === 3) {
    $.ui.toast('Saymend 沒有在執行')
  } else if (code === 4) {
    $.ui.toast('Saymend 正在進行另一段聽寫')
  } else if (code === 7) {
    $.ui.toast('Saymend 的語音 model 尚未就緒')
  } else if (code === 8) {
    $.ui.toast('Saymend 沒有麥克風權限')
  } else {
    $.ui.toast(errorMessage !== '' ? `聽寫失敗：${errorMessage}` : `聽寫失敗（結束碼 ${String(code)}）`)
  }
}

/**
 * 邊唸邊聽用：朗讀結束後開始計時，使用者一直沒開口就取消這段聽寫、迴圈待命。
 * （一般聆聽用 CLI 的 `--no-speech-seconds`；邊唸邊聽時麥克風在朗讀期間就開了，
 * 不能從開麥起算。）
 */
function armNoSpeech($: EngineInterface, handle: Listening): void {
  $.clock.after(NO_SPEECH_SECONDS * 1000, () => {
    if (listening === handle && !handle.hasSpoken) {
      handle.cancel()
      $.ui.toast('沒聽到聲音，語音迴圈待命中。輸入 /listen 繼續')
    }
  })
}

/**
 * 監看 Saymend 的聽寫狀態：使用者一開始說話（熱鍵或 CLI）就中斷朗讀。
 * 啟動後持續到模組卸載；app 沒開時會以加倍的間隔重試。
 */
function startWatcher($: EngineInterface): void {
  if (isWatching) {
    return
  }
  isWatching = true
  let delay = RETRY_MS

  async function run(): Promise<void> {
    try {
      const child = $.process.spawn({ argv: [bin, 'events', '--json'] })
      child.result.catch(() => undefined)
      const read = createLineReader()
      for await (const piece of child) {
        if (piece.stream !== 'stdout') {
          continue
        }
        for (const line of read(piece.text)) {
          const event = parseEvent(line)
          if (event?.type !== 'state' || event.state === undefined) {
            continue
          }
          delay = RETRY_MS
          saymendState = event.state
          // 自己發起的 CLI 聽寫由 listen 決定何時停朗讀（邊唸邊聽時要等開口）
          const isOwn = event.source === 'cli' && listening !== null
          if (event.state === 'recording' && !isOwn) {
            stopSpeaking()
          }
          refreshStatus($)
        }
      }
    } catch {
      // CLI 不存在或無法啟動：當成連不上，稍後再試
    }
    saymendState = 'unknown'
    refreshStatus($)
    $.clock.after(delay, () => {
      void run()
    })
    delay = Math.min(delay * 2, RETRY_MAX_MS)
  }

  void run()
}

async function setMode($: EngineInterface, next: Mode): Promise<void> {
  mode = next
  await $.store.set('mode', next)
  if (next === 'off') {
    stopSpeaking()
    listening?.cancel()
  } else {
    startWatcher($)
  }
  refreshStatus($)
}

/** 回覆結束後：朗讀，迴圈模式再接著聆聽。 */
async function afterTurn($: EngineInterface, answer: string): Promise<void> {
  // 使用者正在用熱鍵說話就不要插嘴
  if (saymendState === 'recording') {
    return
  }
  const text = toSpeech(answer)

  if (mode === 'loop' && bargeIn && text !== '') {
    // 邊唸邊聽：先開麥再開始唸，使用者隨時開口都能打斷
    const heard = listen($, { submit: true, handsFree: true, overSpeech: true })
    const handle = listening
    await speak($, text)
    if (handle !== null && listening === handle && !handle.hasSpoken) {
      armNoSpeech($, handle)
    }
    await heard

    return
  }

  const outcome = text === '' ? 'done' : await speak($, text)
  if (mode === 'loop' && outcome === 'done') {
    await listen($, { submit: true, handsFree: true })
  }
}

async function saymendStatus($: EngineInterface): Promise<string> {
  try {
    const ran = await $.process.run([bin, 'status', '--json'], { timeoutMs: 5000 })
    const status: unknown = JSON.parse(ran.stdout.trim().split('\n')[0] ?? '')
    const fields = status as { app?: string; state?: string; modelReady?: boolean }
    if (fields.app !== 'running') {
      return '沒有在執行'
    }

    return `${fields.state ?? '未知'}${fields.modelReady === false ? '（model 未就緒）' : ''}`
  } catch (error) {
    return `無法取得（${describe(error)}）`
  }
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await load($)
    await $.command.register({
      name: 'saymend',
      description: '語音模式：off／speak（朗讀回覆）／loop（朗讀後自動聆聽並送出）',
      argumentHint: '[off|speak|loop|stop|status|pause <秒>|max <秒>|bargein on|off|polish on|off]',
      immediate: true,
    })
    await $.command.register({
      name: 'listen',
      description: '用 Saymend 聽寫一段話並直接送出（加 edit 只填入輸入框，不送出）',
      argumentHint: '[edit]',
    })
    if (mode !== 'off') {
      startWatcher($)
    }
    refreshStatus($)

    return next(e)
  })

  on('command.run', { command: 'saymend' }, async ($, e) => {
    await load($)
    const [verb = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const value = rest.join(' ')

    if (verb === 'off' || verb === 'speak' || verb === 'loop') {
      await setMode($, verb)
      const note = {
        off: '語音已關閉。',
        speak: '之後每次回覆結束會朗讀。',
        loop: '語音迴圈已開啟：朗讀後自動聆聽，說完自動送出。說「停止語音」可結束迴圈。',
      }

      return { text: note[verb] }
    }

    if (verb === 'stop') {
      stopSpeaking()
      listening?.cancel()

      return { text: '已中斷朗讀與聆聽。' }
    }

    if (verb === 'pause') {
      if (value !== '') {
        const ms = within(Number(value) * 1000, PAUSE_MIN_MS, PAUSE_MAX_MS)
        if (ms === undefined) {
          return { text: `停頓時間要在 ${PAUSE_MIN_MS / 1000} 到 ${PAUSE_MAX_MS / 1000} 秒之間。` }
        }
        pauseMs = Math.round(ms)
        await $.store.set('pauseMs', pauseMs)
      }

      return { text: `停頓 ${pauseMs / 1000} 秒視為說完。` }
    }

    if (verb === 'max') {
      if (value !== '') {
        const seconds = within(Number(value), MAX_SECONDS_MIN, MAX_SECONDS_MAX)
        if (seconds === undefined) {
          return { text: `單段上限要在 ${MAX_SECONDS_MIN} 到 ${MAX_SECONDS_MAX} 秒之間。` }
        }
        maxSeconds = Math.round(seconds)
        await $.store.set('maxSeconds', maxSeconds)
      }

      return { text: `單段最長 ${maxSeconds} 秒，到了會自動定稿送出。` }
    }

    if (verb === 'bargein') {
      if (value === 'on' || value === 'off') {
        bargeIn = value === 'on'
        await $.store.set('bargeIn', bargeIn)
      }

      return {
        text: bargeIn
          ? '邊唸邊聽：開。迴圈模式下朗讀時就會開麥，直接開口即可打斷。請戴耳機，否則喇叭的聲音會被當成你在說話。'
          : '邊唸邊聽：關。',
      }
    }

    if (verb === 'polish') {
      if (value === 'on' || value === 'off') {
        polish = value === 'on'
        await $.store.set('polish', polish)
      }

      return {
        text: polish
          ? '潤飾：開。說完後先經 Saymend 設定的 LLM 潤飾再送出，會比較慢；潤飾失敗時送出未潤飾的文字。'
          : '潤飾：關。說完直接送出辨識結果。',
      }
    }

    if (verb === 'voice') {
      voice = value === '' || value === 'default' ? undefined : value
      await (voice === undefined ? $.store.delete('voice') : $.store.set('voice', voice))

      return { text: `朗讀語音：${voice ?? '系統預設'}` }
    }

    if (verb === 'bin') {
      bin = value === '' || value === 'default' ? 'saymend' : value
      await (bin === 'saymend' ? $.store.delete('bin') : $.store.set('bin', bin))

      return { text: `saymend CLI：${bin}` }
    }

    if (verb === 'status') {
      return {
        text: [
          `模式：${mode}`,
          `邊唸邊聽：${bargeIn ? '開' : '關'}`,
          `潤飾：${polish ? '開' : '關'}`,
          `停頓視為說完：${pauseMs / 1000} 秒`,
          `單段最長：${maxSeconds} 秒`,
          `朗讀語音：${voice ?? '系統預設'}`,
          `saymend CLI：${bin}`,
          `Saymend：${await saymendStatus($)}`,
        ].join('\n'),
      }
    }

    return { text: USAGE }
  })

  on('command.run', { command: 'listen' }, async ($, e) => {
    await load($)
    if (listening !== null) {
      return { text: '已經在聆聽中。' }
    }
    // 預設說完就送出；`edit` 只填入輸入框，讓人改完再自己按 Enter
    const submit = !/(^|\s)(edit|編輯)(\s|$)/.test(e.args)
    void listen($, { submit, handsFree: false }).catch(error => {
      $.ui.toast(`聽寫失敗：${describe(error)}`)
    })

    return {}
  })

  // 使用者送出新的 prompt：正在唸的上一則回覆就不用唸完了
  on('prompt.submit', async ($, e, next) => {
    stopSpeaking()
    // 邊唸邊聽時使用者改用打字送出：還沒聽到開口的那段聽寫就不用等了。
    // 斜線指令不算（例如 /saymend status 不該把聆聽取消掉）
    if (e.command === undefined && listening !== null && !listening.hasSpoken) {
      listening.cancel()
    }
    await load($)
    // 朗讀開著時告訴 model 這回合不要自己發聲（例如 CLAUDE.md 規定的 `say` 完成通知），
    // 否則通知和 mod 的朗讀會重複。context 只有 model 讀得到，使用者看不到
    if (mode !== 'off' && e.command === undefined) {
      return next({ ...e, context: [...(e.context ?? []), SPEAKING_NOTICE] })
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await load($)
    // 只處理主對話正常結束的回覆；subagent、中斷、錯誤都不朗讀
    if (mode !== 'off' && e.agentId === undefined && e.reason === 'answer') {
      // 不等朗讀結束：朗讀與聆聽在 hook 回傳之後繼續進行
      void afterTurn($, e.answer).catch(error => {
        $.ui.toast(`語音處理失敗：${describe(error)}`)
      })
    }

    return done
  })
}

/** 數值落在範圍內就回傳它，否則（含非數字、NaN）回 undefined。 */
function within(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && value >= min && value <= max ? value : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
