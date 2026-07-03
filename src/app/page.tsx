'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import { Mic, Square, Loader2, RefreshCw, Volume2, VolumeX, Share2, Twitter, Copy, Lock } from 'lucide-react'

// ============ Types ============
type Phase = 'idle' | 'connecting' | 'narrating' | 'recording' | 'transcribing' | 'ended'

interface SubtitleChunk {
  seq: number
  text: string
  role: 'narrator' | 'user'
}

interface EndingMeta {
  title: string
  endingType: string
  verdict: string
}

// ============ Constants ============
const AUDIO_PLAYBACK_RATE = 1.0
const DAILY_FREE_LIMIT = 3
const STORAGE_KEY_DATE = 'lbb_date'
const STORAGE_KEY_COUNT = 'lbb_count'

// ============ Helpers: Daily limit ============
function getDailyCount(): { date: string; count: number } {
  if (typeof window === 'undefined') return { date: '', count: 0 }
  const today = new Date().toISOString().slice(0, 10)
  const storedDate = localStorage.getItem(STORAGE_KEY_DATE) || ''
  const storedCount = parseInt(localStorage.getItem(STORAGE_KEY_COUNT) || '0', 10)
  if (storedDate !== today) {
    // 重置
    localStorage.setItem(STORAGE_KEY_DATE, today)
    localStorage.setItem(STORAGE_KEY_COUNT, '0')
    return { date: today, count: 0 }
  }
  return { date: today, count: storedCount }
}

function incrementDailyCount(): number {
  if (typeof window === 'undefined') return 0
  const { date, count } = getDailyCount()
  const newCount = count + 1
  localStorage.setItem(STORAGE_KEY_DATE, date)
  localStorage.setItem(STORAGE_KEY_COUNT, String(newCount))
  return newCount
}

// ============ Component ============
export default function VoiceGamePage() {
  // === State ===
  const [phase, setPhase] = useState<Phase>('idle')
  const [connected, setConnected] = useState(false)
  const [subtitles, setSubtitles] = useState<SubtitleChunk[]>([])
  const [turn, setTurn] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const [narrationText, setNarrationText] = useState('') // 即時累積的旁白
  const [endingMeta, setEndingMeta] = useState<EndingMeta | null>(null)
  const [dailyCount, setDailyCount] = useState(0)
  const [copied, setCopied] = useState(false)

  // === Refs ===
  const socketRef = useRef<Socket | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioQueueRef = useRef<Map<number, string>>(new Map()) // seq -> base64
  const nextPlaySeqRef = useRef<number>(0)
  const currentlyPlayingSeqRef = useRef<number | null>(null)
  const isPlayingRef = useRef<boolean>(false)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const playLoopRunningRef = useRef<boolean>(false)
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const phaseRef = useRef<Phase>('idle')
  const streamRef = useRef<MediaStream | null>(null)
  // 用來中斷正在 await 的 audio 播放 promise
  const interruptResolverRef = useRef<(() => void) | null>(null)

  // Helper: update both phase state and ref
  const setPhaseSafe = useCallback((p: Phase) => {
    phaseRef.current = p
    setPhase(p)
  }, [])

  // ============ Audio Queue Player ============
  // 收到 audio_chunk 就放進 queue；按 seq 順序連續播放
  const tryPlayNext = useCallback(async () => {
    if (playLoopRunningRef.current) return
    if (isPlayingRef.current) return
    playLoopRunningRef.current = true
    try {
      while (true) {
        const nextSeq = nextPlaySeqRef.current
        const audioB64 = audioQueueRef.current.get(nextSeq)
        if (!audioB64) break

        audioQueueRef.current.delete(nextSeq)
        nextPlaySeqRef.current = nextSeq + 1
        isPlayingRef.current = true
        currentlyPlayingSeqRef.current = nextSeq
        setIsPlaying(true)

        // 播放這個 chunk
        const audioUrl = `data:audio/mp3;base64,${audioB64}`
        const audio = audioElRef.current ?? new Audio()
        audioElRef.current = audio
        audio.src = audioUrl
        audio.playbackRate = AUDIO_PLAYBACK_RATE
        audio.muted = muted

        let interrupted = false
        await new Promise<void>((resolve) => {
          // 註冊 resolver，讓 interruptPlayback 可以中斷
          interruptResolverRef.current = () => {
            interrupted = true
            resolve()
          }
          const onEnded = () => {
            audio.removeEventListener('ended', onEnded)
            audio.removeEventListener('error', onError)
            interruptResolverRef.current = null
            resolve()
          }
          const onError = () => {
            audio.removeEventListener('ended', onEnded)
            audio.removeEventListener('error', onError)
            interruptResolverRef.current = null
            resolve()
          }
          audio.addEventListener('ended', onEnded)
          audio.addEventListener('error', onError)
          audio.play().catch(onError)
        })

        isPlayingRef.current = false
        currentlyPlayingSeqRef.current = null
        setIsPlaying(false)

        // 如果中途被中斷（player-interrupt），停止整個 loop
        if (interrupted) break
      }
    } finally {
      playLoopRunningRef.current = false
    }
  }, [muted])

  // 收到 audio_chunk
  const handleAudioChunk = useCallback((payload: { seq: number; audio: string; format: string }) => {
    audioQueueRef.current.set(payload.seq, payload.audio)
    tryPlayNext()
  }, [tryPlayNext])

  // 中斷所有播放（搶話時呼叫）
  const interruptPlayback = useCallback(() => {
    // 清空 queue
    audioQueueRef.current.clear()
    nextPlaySeqRef.current = 0
    isPlayingRef.current = false
    currentlyPlayingSeqRef.current = null
    setIsPlaying(false)
    // 停止當前 audio
    if (audioElRef.current) {
      audioElRef.current.pause()
      audioElRef.current.src = ''
    }
    // 解開正在 await 的播放 promise（讓 playLoop 跳出）
    if (interruptResolverRef.current) {
      const resolver = interruptResolverRef.current
      interruptResolverRef.current = null
      resolver()
    }
  }, [])

  // ============ Socket ============
  useEffect(() => {
    const socket = io('/?XTransformPort=3003', {
      transports: ['websocket'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 5,
      timeout: 8000,
    })
    socketRef.current = socket

    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    socket.on('text_chunk', (data: { seq: number; text: string }) => {
      setSubtitles(prev => [...prev, { seq: data.seq, text: data.text, role: 'narrator' }])
      setNarrationText(prev => prev + (prev ? '' : '') + data.text)
    })

    socket.on('audio_chunk', handleAudioChunk)

    socket.on('user_text', (data: { text: string }) => {
      setSubtitles(prev => [...prev, { seq: Date.now(), text: data.text, role: 'user' }])
    })

    socket.on('turn_start', (data: { turn: number }) => {
      setTurn(data.turn)
      setNarrationText('')
    })

    socket.on('turn_complete', (data: { turn: number; isEnding: boolean }) => {
      if (typeof data.turn === 'number') setTurn(data.turn)
      setPhaseSafe('idle')
    })

    socket.on('game_over', (data: { ending?: string; meta?: EndingMeta }) => {
      if (data?.meta) {
        setEndingMeta(data.meta)
      }
      setPhaseSafe('ended')
    })

    socket.on('status', (data: { stage: string }) => {
      if (data.stage === 'transcribing') {
        setPhaseSafe('transcribing')
      }
    })

    socket.on('error_msg', (data: { message: string }) => {
      setError(data.message)
      setPhaseSafe('idle')
    })

    socket.on('reset_ok', () => {
      setSubtitles([])
      setTurn(0)
      setNarrationText('')
      setEndingMeta(null)
      setPhaseSafe('idle')
      setError(null)
      interruptPlayback()
    })

    return () => {
      socket.disconnect()
    }
  }, [handleAudioChunk, interruptPlayback, setPhaseSafe])

  // ============ Daily count: 載入 + 每分鐘檢查重置 ============
  useEffect(() => {
    const { count } = getDailyCount()
    setDailyCount(count)
    const interval = setInterval(() => {
      const { count: c } = getDailyCount()
      setDailyCount(c)
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  // ============ Recording ============
  const startRecording = useCallback(async () => {
    setError(null)
    // 搶話中斷：立刻停止當前播放
    interruptPlayback()

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
      })
      streamRef.current = stream
      audioChunksRef.current = []

      // 偏好用 webm/opus，向下相容
      let mimeType = 'audio/webm;codecs=opus'
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm'
      }
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/ogg'
      }
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = ''
      }

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data)
        }
      }

      recorder.start(250) // 每 250ms 切一塊，確保及時上傳
      setPhaseSafe('recording')
      setRecordSeconds(0)
      recordTimerRef.current = setInterval(() => {
        setRecordSeconds(s => s + 1)
      }, 1000)
    } catch (err) {
      console.error('getUserMedia failed', err)
      setError('無法存取麥克風：' + String(err))
      setPhaseSafe('idle')
    }
  }, [interruptPlayback, setPhaseSafe])

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      setPhaseSafe('idle')
      return
    }

    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }

    recorder.onstop = async () => {
      // 停止 stream tracks
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }

      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      if (blob.size === 0) {
        setError('錄音為空')
        setPhaseSafe('idle')
        return
      }

      // 轉 base64
      const reader = new FileReader()
      reader.onloadend = () => {
        const result = reader.result as string
        const base64 = result.split(',')[1]
        if (socketRef.current?.connected) {
          socketRef.current.emit('submit_audio', { audio: base64, format: recorder.mimeType })
          setPhaseSafe('transcribing')
        } else {
          setError('未連線')
          setPhaseSafe('idle')
        }
      }
      reader.readAsDataURL(blob)
    }

    recorder.stop()
  }, [setPhaseSafe])

  // ============ Game Actions ============
  const startGame = useCallback(() => {
    // 檢查 daily limit
    const { count } = getDailyCount()
    if (count >= DAILY_FREE_LIMIT) {
      setError(`今日已玩 ${DAILY_FREE_LIMIT} 局免費額度，明天再來吧。`)
      return
    }
    setError(null)
    setSubtitles([])
    setNarrationText('')
    setEndingMeta(null)
    setTurn(0)
    interruptPlayback()
    nextPlaySeqRef.current = 0
    setPhaseSafe('narrating')
    // 開局時 increment
    const newCount = incrementDailyCount()
    setDailyCount(newCount)
    socketRef.current?.emit('start_game')
  }, [interruptPlayback, setPhaseSafe])

  const resetGame = useCallback(() => {
    interruptPlayback()
    nextPlaySeqRef.current = 0
    socketRef.current?.emit('reset_game')
  }, [interruptPlayback])

  // ============ Share helpers ============
  const buildShareText = useCallback(() => {
    if (!endingMeta) return ''
    const opening = subtitles.find(s => s.role === 'narrator')?.text || ''
    const ending = subtitles.filter(s => s.role === 'narrator').slice(-1)[0]?.text || ''
    return `【人生盲盒 · ${endingMeta.endingType}】${endingMeta.title}

開場：${opening.slice(0, 50)}${opening.length > 50 ? '...' : ''}

結局：${ending.slice(0, 50)}${ending.length > 50 ? '...' : ''}

AI 判詞：${endingMeta.verdict}

你的人生，5 分鐘一局：
https://preview-chat-ee6d98a4-ca67-4526-b626-44c9cb958846.space-z.ai/`
  }, [endingMeta, subtitles])

  const handleShareTwitter = useCallback(() => {
    const text = buildShareText()
    if (!text) return
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank')
  }, [buildShareText])

  const handleShareCopy = useCallback(async () => {
    const text = buildShareText()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [buildShareText])

  const handleShareNative = useCallback(async () => {
    const text = buildShareText()
    if (!text) return
    if (navigator.share) {
      try {
        await navigator.share({ title: '人生盲盒', text })
      } catch {
        // 用戶取消
      }
    } else {
      handleShareCopy()
    }
  }, [buildShareText, handleShareCopy])

  // ============ Render ============
  const canRecord = connected && (phase === 'idle' || phase === 'narrating' || phase === 'transcribing') && phase !== 'ended'
  const remainingToday = Math.max(0, DAILY_FREE_LIMIT - dailyCount)
  const isOutOfCredits = remainingToday === 0 && phase === 'idle' && subtitles.length === 0
  const openingText = subtitles.find(s => s.role === 'narrator')?.text || ''
  const endingText = subtitles.filter(s => s.role === 'narrator').slice(-1)[0]?.text || ''

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-between p-6 relative overflow-hidden">
      {/* Background ambient glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80vmin] h-[80vmin] rounded-full blur-3xl transition-all duration-1000 ${
          phase === 'recording' ? 'bg-red-900/30 scale-110' :
          isPlaying ? 'bg-amber-900/30 scale-110' :
          phase === 'narrating' ? 'bg-indigo-900/20 scale-105' :
          phase === 'ended' && endingMeta ? 'bg-purple-900/20 scale-105' :
          'bg-zinc-800/20 scale-100'
        }`} />
      </div>

      {/* Header */}
      <header className="w-full max-w-3xl flex items-center justify-between relative z-10">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'} animate-pulse`} />
          <span className="text-xs text-zinc-400 tracking-widest uppercase">
            {connected ? 'CONNECTED' : 'CONNECTING...'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              const newMuted = !muted
              setMuted(newMuted)
              if (audioElRef.current) audioElRef.current.muted = newMuted
            }}
            className="text-zinc-400 hover:text-white transition-colors"
            aria-label="toggle mute"
          >
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <span className="text-xs text-zinc-500 tracking-widest">
            TURN {turn} / 5
          </span>
          <span className={`text-xs tracking-widest ${remainingToday === 0 ? 'text-red-400' : remainingToday === 1 ? 'text-amber-400' : 'text-zinc-500'}`}>
            · {remainingToday}/{DAILY_FREE_LIMIT} LEFT
          </span>
        </div>
      </header>

      {/* Main: subtitle / status */}
      <main className="w-full max-w-3xl flex-1 flex flex-col items-center justify-center relative z-10 py-8">
        {/* Idle / Initial screen */}
        {phase === 'idle' && subtitles.length === 0 && (
          <div className="text-center space-y-6">
            <div className="space-y-2">
              <h1 className="text-5xl md:text-7xl font-serif font-bold tracking-tight">
                人生盲盒
              </h1>
              <p className="text-zinc-400 text-sm tracking-[0.3em] uppercase">Life · Blind · Box</p>
            </div>
            <p className="text-zinc-500 max-w-md mx-auto text-sm leading-relaxed">
              每次開局都是一個隨機人生。5 分鐘、3-5 輪對話，沒有存檔、沒有重來。
              <br />按住下方按鈕說話，鬆手送出。
            </p>
            {isOutOfCredits ? (
              <div className="space-y-3 mt-4">
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-500 text-sm">
                  <Lock size={14} />
                  今日免費額度已用完
                </div>
                <p className="text-xs text-zinc-600">明天再來，或之後解鎖更多劇情包</p>
              </div>
            ) : (
              <button
                onClick={startGame}
                disabled={!connected}
                className="mt-4 px-8 py-3 rounded-full bg-white text-black font-medium tracking-wider hover:bg-zinc-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                開啟盲盒
              </button>
            )}
            {remainingToday > 0 && remainingToday < DAILY_FREE_LIMIT && (
              <p className="text-xs text-zinc-600 tracking-widest">
                今日剩餘 {remainingToday} 局免費
              </p>
            )}
          </div>
        )}

        {/* Narration / Subtitles display */}
        {(phase !== 'idle' || subtitles.length > 0) && phase !== 'ended' && (
          <div className="w-full space-y-6">
            {/* 即時旁白字幕 */}
            <div className="min-h-[120px] flex items-center justify-center">
              <p className="text-2xl md:text-3xl font-serif text-center leading-relaxed text-zinc-100 max-w-2xl">
                {narrationText || (
                  <span className="text-zinc-600 text-base">
                    {phase === 'transcribing' ? '正在理解你的話...' :
                     phase === 'narrating' ? '正在編織劇情...' :
                     phase === 'recording' ? '正在聆聽...' :
                     ''}
                  </span>
                )}
                {phase === 'narrating' && narrationText && (
                  <span className="inline-block w-1 h-6 bg-amber-400 ml-1 animate-pulse" />
                )}
              </p>
            </div>

            {/* Recording indicator */}
            {phase === 'recording' && (
              <div className="flex flex-col items-center gap-2">
                <div className="flex items-center gap-2 text-red-400">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-xs tracking-widest">RECORDING · {recordSeconds}s</span>
                </div>
              </div>
            )}

            {/* History (collapsible) */}
            {subtitles.length > 1 && (
              <details className="mt-8 text-sm">
                <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300 transition-colors">
                  查看完整對話紀錄（{subtitles.length}）
                </summary>
                <div className="mt-4 space-y-3 max-h-64 overflow-y-auto text-left pr-2">
                  {subtitles.map((s, i) => (
                    <div key={i} className={`text-sm leading-relaxed ${s.role === 'user' ? 'text-amber-300/80' : 'text-zinc-400'}`}>
                      <span className="text-xs text-zinc-600 mr-2">
                        {s.role === 'user' ? '你' : '旁白'}
                      </span>
                      {s.text}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {error && (
              <div className="text-red-400 text-sm text-center">
                {error}
              </div>
            )}
          </div>
        )}

        {/* Ended screen with share card */}
        {phase === 'ended' && (
          <div className="text-center space-y-6">
            <p className="text-zinc-500 text-sm tracking-[0.3em] uppercase">The End</p>

            {/* 結局分享卡 */}
            {endingMeta ? (
              <div className="max-w-md mx-auto">
                <div className="relative rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900 via-black to-zinc-900 p-8 shadow-2xl overflow-hidden">
                  {/* 裝飾光 */}
                  <div className={
                    'absolute -top-20 -right-20 w-40 h-40 rounded-full blur-3xl opacity-30 ' +
                    (endingMeta.endingType === '好結局'
                      ? 'bg-emerald-500'
                      : endingMeta.endingType === '壞結局'
                      ? 'bg-red-500'
                      : 'bg-purple-500')
                  } />

                  {/* 結局類型徽章 */}
                  <div className="flex justify-center mb-4">
                    <span className={
                      'inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs tracking-widest ' +
                      (endingMeta.endingType === '好結局'
                        ? 'bg-emerald-900/50 text-emerald-300 border border-emerald-700'
                        : endingMeta.endingType === '壞結局'
                        ? 'bg-red-900/50 text-red-300 border border-red-700'
                        : 'bg-purple-900/50 text-purple-300 border border-purple-700')
                    }>
                      {endingMeta.endingType}
                    </span>
                  </div>

                  {/* 劇名 */}
                  <h2 className="text-3xl md:text-4xl font-serif font-bold mb-2">
                    {endingMeta.title}
                  </h2>

                  {/* 開場 */}
                  {openingText && (
                    <div className="mt-6 text-left">
                      <p className="text-xs text-zinc-600 tracking-widest mb-1">開場</p>
                      <p className="text-sm text-zinc-400 italic line-clamp-3">
                        {openingText}
                      </p>
                    </div>
                  )}

                  {/* 結局 */}
                  {endingText && (
                    <div className="mt-4 text-left">
                      <p className="text-xs text-zinc-600 tracking-widest mb-1">結局</p>
                      <p className="text-sm text-zinc-300 line-clamp-3">
                        {endingText}
                      </p>
                    </div>
                  )}

                  {/* AI 判詞 */}
                  <div className="mt-6 pt-6 border-t border-zinc-800">
                    <p className="text-xs text-zinc-600 tracking-widest mb-2">AI 判詞</p>
                    <p className="text-lg font-serif italic text-amber-200">
                      「{endingMeta.verdict}」
                    </p>
                  </div>

                  {/* 水印 */}
                  <p className="mt-6 text-[10px] text-zinc-700 tracking-widest">
                    人生盲盒 · LIFE BLIND BOX
                  </p>
                </div>

                {/* 分享按鈕 */}
                <div className="flex flex-wrap justify-center gap-2 mt-4">
                  <button
                    onClick={handleShareNative}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white text-black text-sm font-medium hover:bg-zinc-200 transition-all"
                  >
                    <Share2 size={14} />
                    分享
                  </button>
                  <button
                    onClick={handleShareTwitter}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900 border border-zinc-700 text-zinc-300 text-sm hover:bg-zinc-800 transition-all"
                  >
                    <Twitter size={14} />
                    發到 X
                  </button>
                  <button
                    onClick={handleShareCopy}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900 border border-zinc-700 text-zinc-300 text-sm hover:bg-zinc-800 transition-all"
                  >
                    <Copy size={14} />
                    {copied ? '已複製 ✓' : '複製文字'}
                  </button>
                </div>
              </div>
            ) : (
              <h2 className="text-4xl md:text-5xl font-serif">故事結束</h2>
            )}

            {/* 完整對話紀錄（折疊） */}
            <details className="max-w-xl mx-auto text-sm">
              <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300 transition-colors">
                查看完整對話紀錄（{subtitles.length}）
              </summary>
              <div className="mt-4 space-y-3 max-h-64 overflow-y-auto text-left pr-2">
                {subtitles.map((s, i) => (
                  <div key={i} className={`text-sm leading-relaxed ${s.role === 'user' ? 'text-amber-300/80' : 'text-zinc-300'}`}>
                    <span className="text-xs text-zinc-600 mr-2">
                      {s.role === 'user' ? '你' : '旁白'}
                    </span>
                    {s.text}
                  </div>
                ))}
              </div>
            </details>

            {/* 再開一盒 */}
            {remainingToday > 0 ? (
              <button
                onClick={() => {
                  resetGame()
                  setTimeout(() => startGame(), 300)
                }}
                disabled={remainingToday === 0}
                className="mt-4 inline-flex items-center gap-2 px-6 py-3 rounded-full bg-white text-black font-medium tracking-wider hover:bg-zinc-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <RefreshCw size={16} />
                再開一盒（{remainingToday} 局剩餘）
              </button>
            ) : (
              <div className="mt-4 space-y-2">
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-500 text-sm">
                  <Lock size={14} />
                  今日額度已用完，明天再來
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Footer: Push-to-talk button */}
      {phase !== 'ended' && (
        <footer className="w-full max-w-3xl flex flex-col items-center gap-3 relative z-10 pb-4">
          <button
            onPointerDown={(e) => {
              e.preventDefault()
              if (canRecord && phase !== 'narrating') {
                startRecording()
              } else if (canRecord && phase === 'narrating') {
                // 允許在旁白時搶話
                startRecording()
              }
            }}
            onPointerUp={(e) => {
              e.preventDefault()
              if (phase === 'recording') {
                stopRecording()
              }
            }}
            onPointerLeave={(e) => {
              e.preventDefault()
              if (phase === 'recording') {
                stopRecording()
              }
            }}
            disabled={!canRecord}
            className={`relative w-32 h-32 rounded-full flex items-center justify-center transition-all duration-200 select-none touch-none ${
              phase === 'recording'
                ? 'bg-red-600 scale-110 shadow-[0_0_60px_rgba(220,38,38,0.5)]'
                : isPlaying
                ? 'bg-amber-700/60 scale-105'
                : canRecord
                ? 'bg-zinc-800 hover:bg-zinc-700 ring-1 ring-zinc-700'
                : 'bg-zinc-900 opacity-50 cursor-not-allowed'
            }`}
            aria-label="push to talk"
          >
            {/* Pulse ring while recording */}
            {phase === 'recording' && (
              <span className="absolute inset-0 rounded-full bg-red-600 animate-ping opacity-30" />
            )}
            {/* Pulse ring while AI playing */}
            {isPlaying && phase !== 'recording' && (
              <span className="absolute inset-0 rounded-full bg-amber-500/40 animate-pulse" />
            )}
            {phase === 'recording' ? (
              <Square size={36} className="text-white relative z-10" fill="currentColor" />
            ) : phase === 'transcribing' ? (
              <Loader2 size={36} className="text-zinc-300 animate-spin relative z-10" />
            ) : (
              <Mic size={36} className="text-zinc-300 relative z-10" />
            )}
          </button>
          <p className="text-xs text-zinc-500 tracking-widest text-center">
            {phase === 'recording' ? '鬆手送出' :
             isPlaying ? 'AI 說話中 · 按住可搶話' :
             phase === 'transcribing' ? '理解中...' :
             phase === 'narrating' ? '旁白中 · 按住可搶話' :
             canRecord ? '按住說話' :
             '等待連線...'}
          </p>
          {subtitles.length > 0 && phase !== 'narrating' && phase !== 'transcribing' && (
            <button
              onClick={resetGame}
              className="mt-2 text-xs text-zinc-500 hover:text-zinc-300 tracking-widest transition-colors inline-flex items-center gap-1"
            >
              <RefreshCw size={12} />
              重置遊戲
            </button>
          )}
        </footer>
      )}
    </div>
  )
}
