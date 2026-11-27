import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { createLineReader, isStopPhrase, parseEvent, toSpeech } from './speech'

// ── 純函式 ──

test('toSpeech 拿掉程式碼、表格與 markdown 標記', async () => {
  const answer = [
    '## 結果',
    '',
    '已修好 `parse_event`，詳見 [文件](https://example.com/doc)。',
    '',
    '```ts',
    'const x = 1',
    '```',
    '',
    '| 欄 | 值 |',
    '|---|---|',
    '| a | 1 |',
    '',
    '- **重點**：測試通過',
  ].join('\n')

  expect(toSpeech(answer)).toBe(
    ['結果', '已修好 parse_event，詳見 文件。', '（程式碼略）', '（表格略）', '重點：測試通過'].join(
      '\n',
    ),
  )
})

test('toSpeech 超過上限時在句尾截斷並提示', async () => {
  const spoken = toSpeech('第一句話。第二句話。第三句話。', 12)

  expect(spoken).toBe('第一句話。第二句話。\n後面的內容請看畫面。')
})

test('createLineReader 處理跨塊的行與一塊多行', async () => {
  const read = createLineReader()

  expect(read('{"type":"sta')).toEqual([])
  expect(read('rted"}\n{"type":"final","text":"好"}\n{"ty')).toEqual([
    '{"type":"started"}',
    '{"type":"final","text":"好"}',
  ])
  expect(parseEvent('{"type":"final","text":"好"}')?.text).toBe('好')
  expect(parseEvent('不是 JSON')).toBeUndefined()
  expect(parseEvent('{"v":1}')).toBeUndefined()
})

test('isStopPhrase 只認整句的停止指令', async () => {
  expect(isStopPhrase('停止語音。')).toBe(true)
  expect(isStopPhrase('請 結束對話')).toBe(true)
  expect(isStopPhrase('幫我停止語音辨識的那個 bug')).toBe(false)
})

// ── 掛在引擎上的行為 ──

type World = {
  spoken: string[]
  submitted: { text: string; asUser?: boolean }[]
  /** 每則送進去的 prompt 旁，附給 model 看的 context（沒有就是空陣列） */
  contexts: string[][]
  filled: string[]
  toasts: string[]
  spawned: string[][]
  /** `$.process.run` 被呼叫時的 argv（例如 `saymend cancel`） */
  ran: string[][]
  /** 朗讀被中斷（signal abort）的次數 */
  cutOff: number
  /** status line 依序被設成什麼（undefined＝清掉） */
  statuses: (string | undefined)[]
}

/**
 * 代替引擎回答 mod 用到的呼叫。
 * `dictate`：`saymend dictate` 要吐的行與結束碼；`events`：`saymend events` 要吐的行。
 */
function world(
  on: On,
  script: {
    dictate?: { lines: string[]; code: number }
    /** 依序給每一次 `saymend dictate` 用的結果；用完之後回到 `dictate` */
    dictateSequence?: { lines: string[]; code: number }[]
    events?: string[]
    /** events 串流吐完行之後，等到這個 promise 完成才結束（模擬連線持續開著） */
    hold?: Promise<void>
    /** 引擎拒收送出的 prompt 時給的理由 */
    drop?: string
    /** 朗讀要等到這個 promise 完成才唸完（模擬一段還在唸的回覆） */
    speakHold?: Promise<void>
    /** dictate 吐出 `started` 後，等到這個 promise 完成才繼續吐後面的行 */
    dictateHold?: Promise<void>
  } = {},
): World {
  const seen: World = {
    spoken: [],
    submitted: [],
    contexts: [],
    filled: [],
    toasts: [],
    spawned: [],
    ran: [],
    cutOff: 0,
    statuses: [],
  }

  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('audio.speak', async (_, e, next) => {
    seen.spoken.push(e.text)
    next.signal.addEventListener('abort', () => {
      seen.cutOff += 1
    })
    await script.speakHold

    return { value: { via: 'system' as const } }
  })
  on('prompt.submit', (_, e) => {
    seen.submitted.push({
      text: e.text,
      asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined,
    })
    seen.contexts.push([...(e.context ?? [])])

    return script.drop === undefined ? { text: e.text } : { drop: script.drop }
  })
  on('prompt.fill', (_, e) => {
    seen.filled.push(e.text)

    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', (_, e) => {
    seen.ran.push([...e.argv])

    return {
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('process.spawn', async function* (_, e) {
    seen.spawned.push([...e.argv])
    if (e.argv[1] === 'events') {
      for (const line of script.events ?? []) {
        yield { stream: 'stdout' as const, text: `${line}\n` }
      }
      await script.hold

      return { value: { code: 3, signal: null } }
    }
    if (script.dictateHold !== undefined) {
      yield { stream: 'stdout' as const, text: '{"v":1,"type":"started"}\n' }
      await script.dictateHold
    }
    const result = script.dictateSequence?.shift() ?? script.dictate
    for (const line of result?.lines ?? []) {
      yield { stream: 'stdout' as const, text: `${line}\n` }
    }

    return { value: { code: result?.code ?? 0, signal: null } }
  })

  return seen
}

const TURN = { durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

/** 使用者在輸入框打指令時，引擎會帶上的來源與顯示資訊。 */
const TYPED = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

test('speak 模式：回覆結束後朗讀整理過的文字，不聆聽', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'speak' })
  await $.turn.complete({ ...TURN, answer: '已完成 `build`。' })
  await clock.settle()

  expect(seen.spoken).toEqual(['已完成 build。'])
  expect(seen.spawned.some(argv => argv[1] === 'dictate')).toBe(false)
})

test('off 模式：不朗讀', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'off' })
  await $.turn.complete({ ...TURN, answer: '已完成。' })
  await clock.settle()

  expect(seen.spoken).toEqual([])
})

test('loop 模式：朗讀後聆聽，聽到的話以使用者身分送出', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    dictate: {
      lines: ['{"v":1,"type":"started"}', '{"v":1,"type":"final","text":"接著跑測試"}'],
      code: 0,
    },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'loop' })
  await $.turn.complete({ ...TURN, answer: '已完成。' })
  await clock.settle()

  const dictate = seen.spawned.find(argv => argv[1] === 'dictate')
  expect(dictate).toContain('--no-speech-seconds')
  expect(dictate).toContain('--silence-ms')
  expect(seen.submitted).toEqual([{ text: '接著跑測試', asUser: true }])
})

test('loop 模式：說「停止語音」會關掉迴圈而不送出', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    dictate: { lines: ['{"v":1,"type":"final","text":"停止語音。"}'], code: 0 },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'loop' })
  await $.turn.complete({ ...TURN, answer: '已完成。' })
  await clock.settle()

  expect(seen.submitted).toEqual([])
  const status = await $.command.run({ ...TYPED, command: 'saymend', args: 'status' })
  expect(status.text).toContain('模式：speak')
})

test('loop 模式：沒聽到聲音就待命，不送出', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { dictate: { lines: [], code: 6 } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'loop' })
  await $.turn.complete({ ...TURN, answer: '已完成。' })
  await clock.settle()

  expect(seen.submitted).toEqual([])
  expect(seen.toasts.some(text => text.includes('待命'))).toBe(true)
})

test('/listen 說完直接送出；/listen edit 只填進輸入框', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    dictate: { lines: ['{"v":1,"type":"final","text":"幫我看這個錯誤"}'], code: 0 },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'listen', args: '' })
  await clock.settle()
  expect(seen.submitted).toEqual([{ text: '幫我看這個錯誤', asUser: true }])
  expect(seen.filled).toEqual([])

  await $.command.run({ ...TYPED, command: 'listen', args: 'edit' })
  await clock.settle()
  expect(seen.filled).toEqual(['幫我看這個錯誤'])
  expect(seen.submitted.length).toBe(1)
})

test('送出被擋下時，文字留在輸入框並提示', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    dictate: { lines: ['{"v":1,"type":"final","text":"幫我看這個錯誤"}'], code: 0 },
    drop: '被擋下',
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'listen', args: '' })
  await clock.settle()

  expect(seen.filled).toEqual(['幫我看這個錯誤'])
  expect(seen.toasts.some(text => text.includes('沒能自動送出'))).toBe(true)
})

test('Saymend 沒在執行時 /listen 會提示', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    dictate: { lines: ['{"v":1,"type":"error","code":"not_running","message":"app 未執行"}'], code: 3 },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'listen', args: '' })
  await clock.settle()

  expect(seen.toasts).toEqual(['Saymend 沒有在執行'])
  expect(seen.filled).toEqual([])
})

test('使用者正在用熱鍵聽寫時，回覆結束不朗讀', async ($, on) => {
  const clock = mock.clock(on)
  let release = (): void => undefined
  const hold = new Promise<void>(resolve => {
    release = resolve
  })
  const seen = world(on, {
    events: ['{"v":1,"type":"state","state":"recording","source":"hotkey"}'],
    hold,
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'speak' })
  await clock.settle()
  await $.turn.complete({ ...TURN, answer: '已完成。' })
  await clock.settle()

  expect(seen.spawned.some(argv => argv[1] === 'events')).toBe(true)
  expect(seen.spoken).toEqual([])
  release()
})

// ── 邊唸邊聽 ──

/** 一個由測試決定何時完成的 promise。 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined
  const promise = new Promise<void>(resolve => {
    open = resolve
  })

  return { promise, open }
}

test('邊唸邊聽：朗讀時就開麥，聽到開口即切掉朗讀並送出', async ($, on) => {
  const clock = mock.clock(on)
  const speech = gate()
  const seen = world(on, {
    speakHold: speech.promise,
    dictate: {
      lines: [
        '{"v":1,"type":"started"}',
        '{"v":1,"type":"partial","text":"等一下"}',
        '{"v":1,"type":"final","text":"等一下，先跑測試"}',
      ],
      code: 0,
    },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'bargein on' })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'loop' })
  await $.turn.complete({ ...TURN, answer: '這是一段很長的回覆。' })
  await clock.settle()

  const dictate = seen.spawned.find(argv => argv[1] === 'dictate')
  // 待命時間改由 mod 從朗讀結束後起算，不交給 CLI 從開麥起算
  expect(dictate?.includes('--no-speech-seconds')).toBe(false)
  expect(seen.spoken).toEqual(['這是一段很長的回覆。'])
  expect(seen.cutOff).toBe(1)
  expect(seen.submitted).toEqual([{ text: '等一下，先跑測試', asUser: true }])
  speech.open()
})

test('邊唸邊聽：朗讀唸完後一直沒人開口，就取消聽寫並待命', async ($, on) => {
  const clock = mock.clock(on)
  const mic = gate()
  const seen = world(on, { dictateHold: mic.promise, dictate: { lines: [], code: 5 } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'bargein on' })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'loop' })
  await $.turn.complete({ ...TURN, answer: '已完成。' })
  await clock.settle()

  // 朗讀已唸完、麥克風還開著：還沒到待命時間，不該取消
  await clock.advance(9000)
  expect(seen.ran.some(argv => argv[1] === 'cancel')).toBe(false)

  await clock.advance(2000)
  expect(seen.ran.some(argv => argv[1] === 'cancel')).toBe(true)
  expect(seen.toasts.some(text => text.includes('待命'))).toBe(true)
  expect(seen.submitted).toEqual([])
  mic.open()
})

test('邊唸邊聽關閉時（預設）：迴圈照舊等唸完才開麥', async ($, on) => {
  const clock = mock.clock(on)
  const speech = gate()
  const seen = world(on, {
    speakHold: speech.promise,
    dictate: { lines: ['{"v":1,"type":"final","text":"好"}'], code: 0 },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'bargein off' })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'loop' })
  await $.turn.complete({ ...TURN, answer: '已完成。' })
  await clock.settle()
  expect(seen.spawned.some(argv => argv[1] === 'dictate')).toBe(false)

  speech.open()
  await clock.settle()
  expect(seen.submitted).toEqual([{ text: '好', asUser: true }])
})

// ── 可調的停頓時間與單段上限 ──

test('/saymend pause 與 max 會改變交給 CLI 的參數，超出範圍則拒絕', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    dictate: { lines: ['{"v":1,"type":"final","text":"好"}'], code: 0 },
  })
  const flag = (argv: string[] | undefined, name: string): string | undefined =>
    argv === undefined ? undefined : argv[argv.indexOf(name) + 1]

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'bargein off' })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'pause 3' })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'max 300' })
  await $.command.run({ ...TYPED, command: 'listen', args: '' })
  await clock.settle()

  const first = seen.spawned.find(argv => argv[1] === 'dictate')
  expect(flag(first, '--silence-ms')).toBe('3000')
  expect(flag(first, '--max-seconds')).toBe('300')

  // 超出範圍或不是數字：回報範圍，設定維持原值
  const tooShort = await $.command.run({ ...TYPED, command: 'saymend', args: 'pause 0.1' })
  expect(tooShort.text).toContain('0.5 到 10 秒')
  const notNumber = await $.command.run({ ...TYPED, command: 'saymend', args: 'max 很久' })
  expect(notNumber.text).toContain('10 到 3600 秒')
  const status = await $.command.run({ ...TYPED, command: 'saymend', args: 'status' })
  expect(status.text).toContain('停頓視為說完：3 秒')
  expect(status.text).toContain('單段最長：300 秒')

  // 還原成預設值，避免影響同一個模組狀態下的其他測試
  await $.command.run({ ...TYPED, command: 'saymend', args: 'pause 1.5' })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'max 120' })
})

// ── status line ──

test('status line 只在做事時顯示：待命時清掉，熱鍵聽寫時顯示提示', async ($, on) => {
  const clock = mock.clock(on)
  const hotkey = gate()
  const seen = world(on, {
    events: ['{"v":1,"type":"state","state":"recording","source":"hotkey"}'],
    hold: hotkey.promise,
    dictate: { lines: ['{"v":1,"type":"final","text":"好"}'], code: 0 },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'loop' })
  await clock.settle()
  // 使用者按著 Saymend 熱鍵說話：顯示的是熱鍵聽寫，不是常駐的模式提示
  expect(seen.statuses.at(-1)).toBe('Saymend 熱鍵聽寫中…')

  // 熱鍵聽寫結束（事件串流斷開）→ 迴圈模式還開著，但待命時不留任何一行
  hotkey.open()
  await clock.settle()
  expect(seen.statuses.at(-1)).toBeUndefined()

  // /listen 期間顯示聆聽中，結束後再清掉
  await $.command.run({ ...TYPED, command: 'listen', args: '' })
  await clock.settle()
  expect(seen.statuses.some(text => text?.startsWith('聆聽中'))).toBe(true)
  expect(seen.statuses.at(-1)).toBeUndefined()
  expect(seen.statuses.some(text => text?.includes('語音迴圈'))).toBe(false)
})

// ── 潤飾 ──

test('/saymend polish on 之後聽寫會帶 --polish，off 則不帶', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    dictate: { lines: ['{"v":1,"type":"final","text":"好"}'], code: 0 },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'polish on' })
  await $.command.run({ ...TYPED, command: 'listen', args: '' })
  await clock.settle()
  expect(seen.spawned.filter(argv => argv[1] === 'dictate').at(-1)).toContain('--polish')

  await $.command.run({ ...TYPED, command: 'saymend', args: 'polish off' })
  await $.command.run({ ...TYPED, command: 'listen', args: '' })
  await clock.settle()
  expect(seen.spawned.filter(argv => argv[1] === 'dictate').at(-1)?.includes('--polish')).toBe(
    false,
  )
})

test('朗讀開著時，送出的 prompt 會附上「不要自行發聲」的說明；off 與斜線指令不附', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'speak' })
  await $.prompt.submit({ text: '幫我跑測試', wait: false, origin: { kind: 'composer' } })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'off' })
  await $.prompt.submit({ text: '再跑一次', wait: false, origin: { kind: 'composer' } })
  await clock.settle()

  expect(seen.contexts).toHaveLength(2)
  expect(seen.contexts[0]).toHaveLength(1)
  expect(seen.contexts[0]?.[0]).toContain('不要自行執行 `say`')
  expect(seen.contexts[1]).toEqual([])
})

test('/saymend 不帶參數與 /saymend listen 都等同 /listen；listen edit 只填進輸入框', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    dictate: { lines: ['{"v":1,"type":"final","text":"幫我看這個錯誤"}'], code: 0 },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: '' })
  await clock.settle()
  expect(seen.submitted).toEqual([{ text: '幫我看這個錯誤', asUser: true }])

  await $.command.run({ ...TYPED, command: 'saymend', args: 'listen' })
  await clock.settle()
  expect(seen.submitted.length).toBe(2)
  expect(seen.filled).toEqual([])

  await $.command.run({ ...TYPED, command: 'saymend', args: 'listen edit' })
  await clock.settle()
  expect(seen.filled).toEqual(['幫我看這個錯誤'])
  expect(seen.submitted.length).toBe(2)

  const status = await $.command.run({ ...TYPED, command: 'saymend', args: 'status' })
  expect(status.text).toContain('模式：off')
})

test('邊唸邊聽：朗讀還沒唸完聽寫就空手結束時，重開一段繼續聽，不待命', async ($, on) => {
  const clock = mock.clock(on)
  const speech = gate()
  const seen = world(on, {
    speakHold: speech.promise,
    dictateSequence: [
      // 第一段：環境聲音被當成開口，接著靜音就定稿，結果是空的
      { lines: ['{"v":1,"type":"error","code":"empty_result","message":"辨識結果為空"}'], code: 6 },
      { lines: ['{"v":1,"type":"final","text":"等一下"}'], code: 0 },
    ],
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'bargein on' })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'loop' })
  await $.turn.complete({ ...TURN, answer: '這是一段很長的回覆。' })
  await clock.settle()

  expect(seen.spawned.filter(argv => argv[1] === 'dictate')).toHaveLength(2)
  expect(seen.toasts.some(text => text.includes('待命'))).toBe(false)
  expect(seen.cutOff).toBe(1)
  expect(seen.submitted).toEqual([{ text: '等一下', asUser: true }])
  speech.open()
})

test('邊唸邊聽：朗讀唸完之後聽寫才空手結束，照舊待命不重開', async ($, on) => {
  const clock = mock.clock(on)
  const mic = gate()
  const seen = world(on, { dictateHold: mic.promise, dictate: { lines: [], code: 6 } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'bargein on' })
  await $.command.run({ ...TYPED, command: 'saymend', args: 'loop' })
  await $.turn.complete({ ...TURN, answer: '已完成。' })
  await clock.settle()
  mic.open()
  await clock.settle()

  expect(seen.spawned.filter(argv => argv[1] === 'dictate')).toHaveLength(1)
  expect(seen.toasts.some(text => text.includes('待命'))).toBe(true)
})

