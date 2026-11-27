// saymend-voice：用 Saymend 本機語音輸入，並以系統語音（macOS `say`）朗讀回覆。
//
// 跟 Saymend 的唯一介面是 `saymend` CLI（契約 v1）：
//   saymend dictate --json …  聽寫一段，結果只回傳、不上屏
//   saymend events --json     長駐串流，回報所有來源的聽寫狀態
//     --presence loop         （較新的 Saymend）宣告這個 session 開著 loop；
//                             事件會帶 `presence`，是所有 session 的統計
//   saymend cancel            丟棄目前 CLI 來源的聽寫
//   saymend status --json     目前狀態
//
// 模式（存在 $.state，只在當下的 session 有效；其他設定存在 $.store，整台機器共用）：
//   off   什麼都不做
//   read  每次回覆結束後朗讀
//   loop  朗讀後自動聆聽，說完自動送出（免手動迴圈）
// 新 session 從 off 開始；`autoRead` 開著時從 read 開始。loop 不能當起始值：
// 同時開著的 session 會搶同一支麥克風。
//
// 邊唸邊聽（bargeIn，預設關）：迴圈模式下朗讀一開始就同時開麥，使用者一開口
// 就切掉朗讀。喇叭的聲音會被當成有人說話，所以只適合戴耳機時開。
//
// 兩種使用情境：
//   本機  Claude Code 與 Saymend 在同一台 Mac：直接執行 `saymend`，朗讀用引擎的系統語音。
//   遠端  Claude Code 在 SSH 連過去的主機上：`bin` 與 `speaker` 指到遠端的 client
//         （由 Saymend.app 的「設定 › 遠端」安裝與連線，見 Saymend repo 的 docs/remote.md），
//         聽寫與朗讀都轉回 Mac 執行。mod 的邏輯兩邊相同。

import type { EngineInterface, ProcessSpawnResult, Register } from 'claude-code'

import type { Mode } from '../types'
import { createLineReader, isStopPhrase, parseEvent, toSpeech } from './speech'

/** 這個 session 的語音模式（$.state）。 */
const MODE = { plugin: 'saymend-voice', key: 'mode' } as const

/** 說話後連續靜音多久視為說完（毫秒）：預設值與 `/saymend silence` 可設的範圍。 */
const DEFAULT_SILENCE_MS = 1500
const SILENCE_MIN_MS = 500
const SILENCE_MAX_MS = 10_000
/** 單段聽寫上限（秒）：預設值與 `/saymend limit` 可設的範圍（上限是 CLI 的上限）。 */
const DEFAULT_LIMIT_SECONDS = 120
const LIMIT_SECONDS_MIN = 10
const LIMIT_SECONDS_MAX = 3600
/** 免手動迴圈：開始聆聽後多久沒人說話就待命（秒）。 */
const NO_SPEECH_SECONDS = 10
/** 邊唸邊聽時麥克風在朗讀期間就開了：單段上限要多留這段朗讀的時間（秒）。 */
const BARGE_EXTRA_SECONDS = 480
/** 邊唸邊聽時，朗讀期間聽寫自己空手結束後最多重開幾次（防止異常時無限重開） */
const BARGE_MAX_RESTARTS = 30
/** `saymend events` 斷線後重連的間隔（毫秒），逐次加倍到上限。 */
const RETRY_MS = 2000
const RETRY_MAX_MS = 60_000

const KILLED: ProcessSpawnResult = { code: null, signal: 'SIGTERM' }

/** `$.store` 裡改過名的設定：舊名稱 → 新名稱。 */
const RENAMED_KEYS = [
  ['autoSpeak', 'autoRead'],
  ['pauseMs', 'silenceMs'],
  ['maxSeconds', 'limitSeconds'],
] as const

const USAGE = [
  'Dictation',
  '  /saymend                          dictate one utterance and send it (same as /listen)',
  '  /saymend listen draft             dictate into the prompt box as a draft, without sending',
  'Voice mode (pick one; this session only)',
  '  /saymend off                      do not read replies aloud (default)',
  '  /saymend read                     read each reply aloud when it finishes',
  '  /saymend loop                     read the reply, then listen and send what you say',
  'Control',
  '  /saymend cancel                   stop reading; discard the dictation in progress',
  '  /saymend status                   show the mode and every setting',
  'Settings (shared by every session on this machine)',
  '  /saymend autoread on|off          start every new session in read',
  '  /saymend silence <seconds>        silence that counts as finished speaking (0.5–10, default 1.5)',
  '  /saymend limit <seconds>          longest single utterance (10–3600, default 120)',
  '  /saymend bargein on|off           listen while reading; talk to interrupt (headphones needed)',
  '  /saymend polish on|off            polish with the LLM set in Saymend before sending',
  '  /saymend pin on|off               keep the status line while idle (default on)',
  '  /saymend voice <name|default>     system voice used for reading',
  '  /saymend bin <path|default>       path of the saymend CLI (the client, when remote)',
  '  /saymend speaker <command|default>  command that reads aloud (the client, when remote)',
].join('\n')

// ── 模組狀態（reload 後歸零；設定值從 $.store 讀回） ──
let mode: Mode = 'off'
let voice: string | undefined
let bin = 'saymend'
/**
 * 朗讀改用這個外部指令（介面同 macOS 的 `say`：`[-v 語音]`，文字從 stdin 進）。
 * 沒設定就用引擎的系統語音。遠端使用時設成遠端 client 的 `say`。
 */
let speaker: string | undefined
/** 邊唸邊聽：迴圈模式下朗讀時就開麥，開口即打斷。 */
let bargeIn = false
/** 送出前先讓 Saymend 用設定中的 LLM provider 潤飾（`dictate --polish`）。 */
let polish = false
/** 待命時也把 Saymend 的狀態留在 status line（預設開；關掉後只在做事時顯示） */
let pin = true
/** 新 session 的起始模式是 read 而不是 off（預設關） */
let autoRead = false
let silenceMs = DEFAULT_SILENCE_MS
let limitSeconds = DEFAULT_LIMIT_SECONDS
let isLoaded = false

let speaking: AbortController | null = null
type Listening = {
  cancel: () => void
  /** 這段聽寫是否已經聽到使用者開口。 */
  hasSpoken: boolean
}
let listening: Listening | null = null
let isWatching = false
/** 目前這條 `saymend events` 連線：宣告的 presence tag，以及結束它的方法。 */
let watching: { tag: string | undefined; kill: () => void } | null = null
/** 每次重開監看就加一；舊的那一輪看到數字變了就自己收掉。 */
let watchEpoch = 0
let retryDelay = RETRY_MS
/**
 * Saymend 目前狀態（契約 v1 的 `state`），另外兩個是這裡自己的：
 * `unknown` Saymend 沒在執行或 CLI 不存在（顯示成 offline）；
 * `unreachable` 遠端的 client 連不回 Mac。
 */
let saymendState = 'unknown'
/** 所有連到這個 Saymend 的 session 裡，有幾個開著 loop；Saymend 沒回報就是 undefined。 */
let loopSessions: number | undefined
/** `saymend events --presence` 能不能用；舊版 CLI 不認得這個參數（exit 2），試過一次就不再帶。 */
let isPresenceSupported = true
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
  // 0.2 以前模式存在 $.store，開一次所有 session 都跟著開；現在只留在 session 裡
  if ((await $.store.get('mode')) !== undefined) {
    await $.store.delete('mode')
  }
  // 0.6 以前的名稱：autoSpeak、pauseMs、maxSeconds。搬到新名稱，舊的刪掉
  for (const [old, renamed] of RENAMED_KEYS) {
    const value = await $.store.get(old)
    if (value !== undefined) {
      if ((await $.store.get(renamed)) === undefined) {
        await $.store.set(renamed, value)
      }
      await $.store.delete(old)
    }
  }
  autoRead = (await $.store.get('autoRead')) === true
  // 模式 speak 改名為 read；reload 前存在 session 裡的舊值照新名稱讀
  const held: unknown = (await $.state.get(MODE)).value
  mode =
    held === 'off' || held === 'read' || held === 'loop'
      ? held
      : held === 'speak' || autoRead
        ? 'read'
        : 'off'
  const storedVoice = await $.store.get('voice')
  voice = typeof storedVoice === 'string' && storedVoice !== '' ? storedVoice : undefined
  const storedBin = await $.store.get('bin')
  bin = typeof storedBin === 'string' && storedBin !== '' ? storedBin : 'saymend'
  const storedSpeaker = await $.store.get('speaker')
  speaker = typeof storedSpeaker === 'string' && storedSpeaker !== '' ? storedSpeaker : undefined
  bargeIn = (await $.store.get('bargeIn')) === true
  polish = (await $.store.get('polish')) === true
  pin = (await $.store.get('pin')) !== false
  silenceMs = within(await $.store.get('silenceMs'), SILENCE_MIN_MS, SILENCE_MAX_MS) ?? DEFAULT_SILENCE_MS
  limitSeconds =
    within(await $.store.get('limitSeconds'), LIMIT_SECONDS_MIN, LIMIT_SECONDS_MAX) ??
    DEFAULT_LIMIT_SECONDS
  isLoaded = true
}

/**
 * status line 一律由目前狀態推導，避免各處互相覆蓋。
 * 只在「正在做事」時顯示；待命時清掉，不常駐一行模式提示
 * （模式用 `/saymend status` 查）。
 */
function refreshStatus($: EngineInterface): void {
  if (listening !== null && speaking !== null) {
    $.ui.status('reading reply… talk to interrupt (/saymend cancel)')
  } else if (listening !== null && saymendState === 'polishing') {
    $.ui.status('polishing… (/saymend cancel to discard)')
  } else if (listening !== null && saymendState === 'transcribing') {
    $.ui.status('transcribing… (/saymend cancel to discard)')
  } else if (listening !== null) {
    $.ui.status('listening… pause when done (/saymend cancel to discard)')
  } else if (speaking !== null) {
    $.ui.status('reading reply… (/saymend cancel to stop)')
  } else if (BUSY_STATES.has(saymendState)) {
    // 不是這個 mod 發起的聽寫：使用者按了 Saymend 熱鍵
    $.ui.status('hotkey dictation…')
  } else if (pin) {
    // 常駐：待命時也留一行，看得到 Saymend 連不連得上、這個 session 的語音模式。
    // 引擎會在前面標上 mod 的名字，所以這裡不再寫 Saymend；用英文，跟指令的字一致
    const state = saymendState === 'unknown' ? 'offline' : saymendState
    const others = otherLoopSessions()
    const crowd =
      others === 0
        ? ''
        : mode === 'loop'
          ? `｜${others + 1} sessions in loop`
          : `｜${others} other session${others === 1 ? '' : 's'} in loop`
    $.ui.status(`${state}｜${mode}${crowd}`)
  } else {
    $.ui.status(undefined)
  }
}

/** 這個 session 自己有沒有被算進 `loopSessions`（開著 loop，而且連線有宣告 presence）。 */
function isCountedAsLoop(): boolean {
  return mode === 'loop' && watching?.tag === 'loop'
}

/** 除了這個 session 以外，還有幾個 session 開著 loop；不知道就當成 0。 */
function otherLoopSessions(total: number | undefined = loopSessions): number {
  return total === undefined ? 0 : Math.max(0, total - (isCountedAsLoop() ? 1 : 0))
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
    if (speaker === undefined) {
      await $.audio.speak(text, { voice, signal: stop.signal })
    } else {
      await speakWith($, speaker, text, stop.signal)
    }

    return 'done'
  } catch (error) {
    if (stop.signal.aborted) {
      return 'aborted'
    }
    $.ui.toast(`Reading aloud failed: ${describe(error)}`)

    return 'failed'
  } finally {
    if (speaking === stop) {
      speaking = null
    }
    refreshStatus($)
  }
}

/**
 * 用外部指令朗讀：`<指令> [-v 語音]`，文字從 stdin 進（與 macOS 的 `say` 相同）。
 * 中斷時結束那個行程；指令失敗就丟出它在 stderr 說的原因。
 */
async function speakWith(
  $: EngineInterface,
  command: string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const argv = voice === undefined ? [command] : [command, '-v', voice]
  const child = $.process.spawn({ argv, input: text })
  child.result.catch(() => undefined)
  const kill = (): void => {
    void child.return(KILLED).catch(() => undefined)
  }
  signal.addEventListener('abort', kill, { once: true })
  let complaint = ''
  try {
    for await (const piece of child) {
      if (piece.stream === 'stderr') {
        complaint += piece.text
      }
    }
    if (signal.aborted) {
      throw new Error('reading interrupted')
    }
    const { code } = await child.result
    if (code !== 0) {
      throw new Error(complaint.trim() !== '' ? complaint.trim() : `exit code ${String(code)}`)
    }
  } finally {
    signal.removeEventListener('abort', kill)
  }
}

/**
 * 請 Saymend 聽寫一段。
 * `submit`：拿到文字後直接送出；否則填進輸入框讓人確認（`/listen draft`）。
 * `handsFree`：免手動迴圈的一輪，沒人說話就待命，並接受口頭停止指令。
 * `overSpeech`：邊唸邊聽，朗讀還在進行就開麥；聽到開口才切掉朗讀。
 *   這時沒人說話的待命時間改由 `armNoSpeech` 從朗讀結束後起算。
 */
async function listen(
  $: EngineInterface,
  options: { submit: boolean; handsFree: boolean; overSpeech?: boolean; restarts?: number },
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
    String(silenceMs),
    '--max-seconds',
    String(
      isOverSpeech ? Math.min(LIMIT_SECONDS_MAX, limitSeconds + BARGE_EXTRA_SECONDS) : limitSeconds,
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
  let errorCode = ''
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
          errorCode = event.code ?? ''
        }
      }
    }
    code = (await child.result).code
  } catch (error) {
    if (!isCancelled) {
      $.ui.toast(`Cannot run ${bin}: ${describe(error)}`)
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
      await setMode($, 'read')
      $.ui.toast('Loop is off; mode is now read (replies are still read aloud)')
    } else if (options.submit) {
      const sent = await $.prompt.submit({ text: finalText, asUser: true })
      if (sent.drop !== undefined) {
        // 沒送進去就把文字留在輸入框，不要讓剛說的話消失
        await $.prompt.fill({ text: finalText, mode: 'insert' })
        $.ui.toast(`Could not send (${sent.drop}); the text is in the prompt box`)
      }
    } else {
      const filled = await $.prompt.fill({ text: finalText, mode: 'insert' })
      if (!filled.isFilled) {
        $.ui.toast(`Could not fill the prompt box: ${finalText}`)
      }
    }

    return
  }

  if (code === 6 || code === 0) {
    // 邊唸邊聽時朗讀還沒唸完，聽寫卻空手結束：多半是環境聲音被當成開口、接著靜音就定稿了。
    // 這時不能待命，否則朗讀後半段開口沒人聽；重開一段繼續聽。
    const restarts = options.restarts ?? 0
    if (isOverSpeech && speaking !== null && mode === 'loop' && restarts < BARGE_MAX_RESTARTS) {
      return listen($, { ...options, restarts: restarts + 1 })
    }
    $.ui.toast(
      options.handsFree
        ? 'Heard nothing; loop is paused. Type /listen to continue'
        : 'Heard nothing',
    )
  } else if (code === 3) {
    // `unreachable` 是遠端 client 回的：問題在回 Mac 的連線，不是 Saymend 沒開
    $.ui.toast(errorCode === 'unreachable' && errorMessage !== '' ? errorMessage : 'Saymend is not running')
  } else if (code === 4) {
    $.ui.toast('Saymend is busy with another dictation')
  } else if (code === 7) {
    $.ui.toast('The Saymend speech model is not ready')
  } else if (code === 8) {
    $.ui.toast('Saymend has no microphone permission')
  } else {
    $.ui.toast(
      errorMessage !== '' ? `Dictation failed: ${errorMessage}` : `Dictation failed (exit code ${String(code)})`,
    )
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
      $.ui.toast('Heard nothing; loop is paused. Type /listen to continue')
    }
  })
}

/** 這個 session 的 events 連線該宣告什麼：開著 loop 才宣告，讓 Saymend 統計有幾個。 */
function presenceTag(): string | undefined {
  return mode === 'loop' && isPresenceSupported ? 'loop' : undefined
}

/** 從事件的 `presence` 讀出開著 loop 的 session 數；Saymend 沒這個欄位就是 undefined。 */
function loopCount(presence: unknown): number | undefined {
  if (typeof presence !== 'object' || presence === null) {
    return undefined
  }
  const count = (presence as { loop?: unknown }).loop

  return typeof count === 'number' ? count : 0
}

/**
 * 監看 Saymend 的聽寫狀態：使用者一開始說話（熱鍵或 CLI）就中斷朗讀。
 * 啟動後持續到模組卸載；app 沒開時會以加倍的間隔重試。
 */
function startWatcher($: EngineInterface): void {
  if (isWatching) {
    // 已經在監看：模式變了的話，連線宣告的 presence 要跟著換
    if (watching !== null && watching.tag !== presenceTag()) {
      restartWatcher($)
    }

    return
  }
  isWatching = true
  void watch($, watchEpoch)
}

/** 馬上重開監看（換了 presence 或換了 `bin`），不等重試的間隔。 */
function restartWatcher($: EngineInterface): void {
  if (!isWatching) {
    return
  }
  watchEpoch += 1
  retryDelay = RETRY_MS
  watching?.kill()
  void watch($, watchEpoch)
}

async function watch($: EngineInterface, epoch: number): Promise<void> {
  if (epoch !== watchEpoch) {
    return
  }
  const tag = presenceTag()
  let code: number | null = null
  let failure = ''
  let own: typeof watching = null
  try {
    const child = $.process.spawn({
      argv: [bin, 'events', '--json', ...(tag === undefined ? [] : ['--presence', tag])],
    })
    child.result.catch(() => undefined)
    own = {
      tag,
      kill: () => {
        void child.return(KILLED).catch(() => undefined)
      },
    }
    watching = own
    const read = createLineReader()
    for await (const piece of child) {
      if (piece.stream !== 'stdout') {
        continue
      }
      for (const line of read(piece.text)) {
        const event = parseEvent(line)
        if (event?.type === 'error') {
          // 串流結束前 CLI 會說原因：`unreachable` 是遠端 client 連不回 Mac
          failure = event.code ?? ''
        }
        if (event?.type !== 'state' || event.state === undefined) {
          continue
        }
        retryDelay = RETRY_MS
        saymendState = event.state
        loopSessions = loopCount(event.presence)
        // 自己發起的 CLI 聽寫由 listen 決定何時停朗讀（邊唸邊聽時要等開口）
        const isOwn = event.source === 'cli' && listening !== null
        if (event.state === 'recording' && !isOwn) {
          stopSpeaking()
        }
        refreshStatus($)
      }
    }
    code = (await child.result).code
  } catch {
    // CLI 不存在或無法啟動：當成連不上，稍後再試
  }
  if (watching === own) {
    watching = null
  }
  if (epoch !== watchEpoch) {
    // 已經被 restartWatcher 換掉，新的那一輪在跑了
    return
  }
  if (tag !== undefined && code === 2) {
    // 舊版 CLI 不認得 --presence（用法錯誤）：之後不帶這個參數，馬上重連
    isPresenceSupported = false
    void watch($, epoch)

    return
  }
  saymendState = failure === 'unreachable' ? 'unreachable' : 'unknown'
  loopSessions = undefined
  refreshStatus($)
  const delay = retryDelay
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
  $.clock.after(delay, () => {
    void watch($, epoch)
  })
}

async function setMode($: EngineInterface, next: Mode): Promise<void> {
  mode = next
  await $.state.set(MODE, next)
  if (next === 'off') {
    stopSpeaking()
    listening?.cancel()
  }
  if (next !== 'off' || isWatching) {
    // 沒在監看就開始；已經在監看則視需要換 presence（開關 loop）
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
    await speak($, text)
    // 朗讀期間聽寫可能重開過，所以看的是「現在這一段」而不是一開始那一段
    const current = listening
    if (current !== null && !current.hasSpoken) {
      armNoSpeech($, current)
    }
    await heard

    return
  }

  const outcome = text === '' ? 'done' : await speak($, text)
  if (mode === 'loop' && outcome === 'done') {
    await listen($, { submit: true, handsFree: true })
  }
}

type SaymendStatus = {
  app?: string
  state?: string
  modelReady?: boolean
  /** 遠端 client 連不上 Mac 時附的原因 */
  message?: string
  presence?: unknown
}

/** 問一次 `saymend status --json`；問不到就丟出錯誤。 */
async function readStatus($: EngineInterface): Promise<SaymendStatus> {
  const ran = await $.process.run([bin, 'status', '--json'], { timeoutMs: 5000 })
  const status: unknown = JSON.parse(ran.stdout.trim().split('\n')[0] ?? '')

  return typeof status === 'object' && status !== null ? (status as SaymendStatus) : {}
}

/** `/saymend status` 用的兩行：Saymend 的狀態，以及開著 loop 的 session 數。 */
async function describeSaymend($: EngineInterface): Promise<string[]> {
  try {
    const fields = await readStatus($)
    if (fields.app !== 'running') {
      return [
        `Saymend: ${
          typeof fields.message === 'string' && fields.message !== '' ? fields.message : 'not running'
        }`,
      ]
    }
    const total = loopCount(fields.presence)

    return [
      `Saymend: ${fields.state ?? 'unknown'}${fields.modelReady === false ? ' (model not ready)' : ''}`,
      `sessions in loop: ${total === undefined ? 'unknown (older Saymend)' : String(total)}`,
    ]
  } catch (error) {
    return [`Saymend: unavailable (${describe(error)})`]
  }
}

/** 開 loop 之前：還有幾個別的 session 已經開著 loop。沒在監看就問 Saymend 一次。 */
async function countOtherLoops($: EngineInterface): Promise<number> {
  if (loopSessions !== undefined) {
    return otherLoopSessions()
  }
  try {
    return otherLoopSessions(loopCount((await readStatus($)).presence))
  } catch {
    return 0
  }
}

/**
 * `/listen` 與 `/saymend listen` 共用：開始聽寫一段話。
 * 不等聽寫結束就回傳，結果由 `listen` 自己送出或填入輸入框。
 */
function beginListening($: EngineInterface, args: string): { text?: string } {
  if (listening !== null) {
    return { text: 'Already listening.' }
  }
  // 預設說完就送出；`draft` 只填入輸入框當草稿，讓人改完再自己按 Enter。
  // 不叫 edit：Saymend 裡的 edit 是「用說的修正已上屏的文字」，是另一回事
  const submit = !/(^|\s)draft(\s|$)/.test(args)
  void listen($, { submit, handsFree: false }).catch(error => {
    $.ui.toast(`Dictation failed: ${describe(error)}`)
  })

  return {}
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    // 新的 session：模式要重新決定，設定也重讀一次
    isLoaded = false
    await load($)
    await $.command.register({
      name: 'saymend',
      description:
        'No argument: dictate one utterance and send it (same as /listen). Voice mode for this session: off, read (read replies aloud), loop (read, then listen and send)',
      argumentHint:
        '[listen [draft]|off|read|loop|cancel|status|autoread on|off|silence <seconds>|limit <seconds>|bargein on|off|polish on|off|pin on|off|bin <path>|speaker <command>]',
      immediate: true,
    })
    await $.command.register({
      name: 'listen',
      description:
        'Dictate one utterance with Saymend and send it (add draft to only fill the prompt box; same as /saymend listen)',
      argumentHint: '[draft]',
    })
    // 常駐狀態列只對有人在看的 session 有意義；非互動的 session 不為了它一直連著 Saymend
    if (mode !== 'off' || (pin && e.isInteractive)) {
      startWatcher($)
    }
    refreshStatus($)

    return next(e)
  })

  on('command.run', { command: 'saymend' }, async ($, e) => {
    await load($)
    // 不帶參數就是聽寫：最常用的動作放在最短的入口
    const [verb = 'listen', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const value = rest.join(' ')

    if (verb === 'listen') {
      return beginListening($, value)
    }

    if (verb === 'off' || verb === 'read' || verb === 'loop') {
      // 要在切換之前數：切換後自己也會被算進去
      const others = verb === 'loop' ? await countOtherLoops($) : 0
      await setMode($, verb)
      const note = {
        off: 'Voice is off for this session.',
        read: 'This session now reads each reply aloud when it finishes.',
        loop: 'Loop is on for this session: it reads each reply, then listens and sends what you say. Say 「停止語音」 to end the loop.',
      }

      const warning =
        others > 0
          ? `\nWarning: ${others} other session${others === 1 ? ' also has' : 's also have'} loop on. Saymend takes one dictation at a time, so what you say goes only to the session that opened the microphone first.`
          : ''

      return { text: note[verb] + warning }
    }

    // 與 saymend CLI 的用詞一致：cancel＝丟棄（CLI 的 stop 是定稿並保留文字，這裡不提供）
    if (verb === 'cancel') {
      stopSpeaking()
      listening?.cancel()

      return { text: 'Cancelled: reading stopped, and a dictation in progress is discarded.' }
    }

    if (verb === 'silence') {
      if (value !== '') {
        const ms = within(Number(value) * 1000, SILENCE_MIN_MS, SILENCE_MAX_MS)
        if (ms === undefined) {
          return { text: `silence must be between ${SILENCE_MIN_MS / 1000} and ${SILENCE_MAX_MS / 1000} seconds.` }
        }
        silenceMs = Math.round(ms)
        await $.store.set('silenceMs', silenceMs)
      }

      return { text: `silence: ${silenceMs / 1000}s counts as finished speaking.` }
    }

    if (verb === 'limit') {
      if (value !== '') {
        const seconds = within(Number(value), LIMIT_SECONDS_MIN, LIMIT_SECONDS_MAX)
        if (seconds === undefined) {
          return { text: `limit must be between ${LIMIT_SECONDS_MIN} and ${LIMIT_SECONDS_MAX} seconds.` }
        }
        limitSeconds = Math.round(seconds)
        await $.store.set('limitSeconds', limitSeconds)
      }

      return { text: `limit: ${limitSeconds}s per utterance; when reached it is finalized and sent.` }
    }

    if (verb === 'bargein') {
      if (value === 'on' || value === 'off') {
        bargeIn = value === 'on'
        await $.store.set('bargeIn', bargeIn)
      }

      return {
        text: bargeIn
          ? 'bargein: on. In loop mode the microphone opens while reading; talk to interrupt. Wear headphones, or the speakers are taken as you talking.'
          : 'bargein: off.',
      }
    }

    if (verb === 'polish') {
      if (value === 'on' || value === 'off') {
        polish = value === 'on'
        await $.store.set('polish', polish)
      }

      return {
        text: polish
          ? 'polish: on. What you say is polished by the LLM set in Saymend before it is sent, which is slower; if polishing fails the unpolished text is sent.'
          : 'polish: off. The recognized text is sent as is.',
      }
    }

    if (verb === 'autoread') {
      if (value === 'on' || value === 'off') {
        autoRead = value === 'on'
        await (autoRead ? $.store.set('autoRead', true) : $.store.delete('autoRead'))
        if (autoRead && mode === 'off') {
          // 開了卻沒聲音會讓人以為沒生效：這個 session 也跟著開始朗讀
          await setMode($, 'read')
        }
      }

      return {
        text: autoRead
          ? 'autoread: on. New sessions start in read (other open sessions follow after /reload-plugins); any session can still turn it off with /saymend off.'
          : 'autoread: off. New sessions start in off; this session keeps its current mode.',
      }
    }

    if (verb === 'pin') {
      if (value === 'on' || value === 'off') {
        pin = value === 'on'
        await (pin ? $.store.delete('pin') : $.store.set('pin', false))
        if (pin) {
          // 語音模式關著時原本不監看 Saymend；要常駐顯示就得一直監看
          startWatcher($)
        }
        refreshStatus($)
      }

      return {
        text: pin
          ? 'pin: on. The status line stays while idle and shows the Saymend state and this session\'s mode, for example "idle｜read".'
          : 'pin: off. The status line shows only while reading, listening or hotkey dictation.',
      }
    }

    if (verb === 'voice') {
      voice = value === '' || value === 'default' ? undefined : value
      await (voice === undefined ? $.store.delete('voice') : $.store.set('voice', voice))

      return { text: `voice: ${voice ?? 'system default'}` }
    }

    if (verb === 'bin') {
      bin = value === '' || value === 'default' ? 'saymend' : value
      await (bin === 'saymend' ? $.store.delete('bin') : $.store.set('bin', bin))
      // 換了 CLI：能力要重新試，監看也馬上改用新的那一支（不等重試間隔）
      isPresenceSupported = true
      restartWatcher($)

      return { text: `saymend CLI: ${bin}` }
    }

    if (verb === 'speaker') {
      speaker = value === '' || value === 'default' ? undefined : value
      await (speaker === undefined ? $.store.delete('speaker') : $.store.set('speaker', speaker))

      return {
        text:
          speaker === undefined
            ? "speaker: this machine's system voice."
            : `speaker: ${speaker} (text on stdin, same interface as macOS say).`,
      }
    }

    if (verb === 'status') {
      return {
        text: [
          `mode: ${mode} (this session only)`,
          `autoread: ${autoRead ? 'on' : 'off'}`,
          `bargein: ${bargeIn ? 'on' : 'off'}`,
          `polish: ${polish ? 'on' : 'off'}`,
          `pin: ${pin ? 'on' : 'off'}`,
          `silence: ${silenceMs / 1000}s`,
          `limit: ${limitSeconds}s`,
          `voice: ${voice ?? 'system default'}`,
          `speaker: ${speaker ?? "this machine's system voice"}`,
          `saymend CLI: ${bin}`,
          ...(await describeSaymend($)),
        ].join('\n'),
      }
    }

    return { text: USAGE }
  })

  on('command.run', { command: 'listen' }, async ($, e) => {
    await load($)

    return beginListening($, e.args)
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
        $.ui.toast(`Voice handling failed: ${describe(error)}`)
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
