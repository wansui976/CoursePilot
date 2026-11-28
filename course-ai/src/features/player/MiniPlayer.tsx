import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AudioLines, Pause, Play, X } from "lucide-react";
import { writePlaybackPosition } from "@/lib/playback";
import { useMiniPlayer, type MiniPlayerSession } from "@/stores/miniPlayer";
import { canBoost } from "./volume";

/** 每隔多久把进度写回断点（秒）：小窗里放着放着关了 App，下次也能从这里接着看。 */
const SAVE_EVERY_S = 5;

/**
 * 应用内迷你播放器：离开视频页时，正在放的视频在角落接着放。
 *
 * 桌面是右下角的一张小卡片（画面在上、标题和按钮在下）；手机是底栏上方的一整条
 * （画面缩成左边的小块），和音乐 App 的迷你播放条一样，不挡内容中间。
 * 点画面或标题回到视频页，工作台从这里放到的地方接着放（见播放器里的接管逻辑）。
 *
 * 外壳只在不在视频页时挂它；回到视频页的那一刻，工作台的播放器接手并把它关掉。
 */
export function MiniPlayer({
  layout,
  onReturn,
  rightInset = 0,
}: {
  /** card：桌面右下角卡片；bar：手机底栏上方的整条。 */
  layout: "card" | "bar";
  onReturn: (session: MiniPlayerSession) => void;
  /** 桌面上右边被停靠的助手占掉的宽度，卡片让开。 */
  rightInset?: number;
}) {
  const session = useMiniPlayer((s) => s.session);
  if (!session) return null;
  return (
    <MiniPlayerView
      // 换了一段交接（另一个视频或同一视频的新来源）就整块重挂，别沿用旧元素的状态。
      key={`${session.videoId}#${session.src}`}
      session={session}
      layout={layout}
      onReturn={onReturn}
      rightInset={rightInset}
    />
  );
}

function MiniPlayerView({
  session,
  layout,
  onReturn,
  rightInset,
}: {
  session: MiniPlayerSession;
  layout: "card" | "bar";
  onReturn: (session: MiniPlayerSession) => void;
  rightInset: number;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(session.playing);
  const [progress, setProgress] = useState(0);
  // 纯音频（播客、录音）没有画面：小窗里画个音频图标，不留一块黑。
  const [audioOnly, setAudioOnly] = useState(false);
  const lastSavedRef = useRef(session.ms / 1000);
  const update = useMiniPlayer((s) => s.update);
  const close = useMiniPlayer((s) => s.close);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.volume = session.volume;
    video.muted = session.muted;
    // 只在挂上时套一次：之后由用户在小窗里操作。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function current(): MiniPlayerSession {
    const video = ref.current;
    return {
      ...session,
      ms: video ? Math.floor(video.currentTime * 1000) : session.ms,
      playing: video ? !video.paused && !video.ended : playing,
    };
  }

  function save(video: HTMLVideoElement) {
    if (video.currentTime > 0) writePlaybackPosition(session.videoId, video.currentTime);
    lastSavedRef.current = video.currentTime;
  }

  function dismiss() {
    const video = ref.current;
    if (video) {
      video.pause();
      save(video);
    }
    close();
  }

  function togglePlay() {
    const video = ref.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }

  const bar = layout === "bar";
  const title = session.title || t("miniPlayer.untitled");

  return (
    <div
      role="region"
      aria-label={t("miniPlayer.label")}
      data-layout={layout}
      className="ca-mini-player"
      style={!bar && rightInset > 0 ? { right: `calc(${rightInset}px + 1rem)` } : undefined}
    >
      <button
        type="button"
        onClick={() => onReturn(current())}
        aria-label={t("miniPlayer.return", { title })}
        title={t("miniPlayer.return", { title })}
        className="ca-mini-player-stage"
      >
        <video
          ref={ref}
          src={session.src}
          playsInline
          disablePictureInPicture
          // 和视频页同一套加载方式（本地媒体服务按 CORS 加载），刚放过的那段能直接从缓存里接上。
          crossOrigin={canBoost(session.src) ? "anonymous" : undefined}
          tabIndex={-1}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            setAudioOnly(video.videoWidth === 0);
            video.currentTime = Math.max(0, session.ms / 1000);
            video.defaultPlaybackRate = session.rate;
            video.playbackRate = session.rate;
            video.preservesPitch = true;
            if (session.playing) void video.play().catch(() => setPlaying(false));
          }}
          onPlay={() => {
            setPlaying(true);
            update({ playing: true });
          }}
          onPause={(event) => {
            setPlaying(false);
            update({ playing: false, ms: Math.floor(event.currentTarget.currentTime * 1000) });
            save(event.currentTarget);
          }}
          onTimeUpdate={(event) => {
            const video = event.currentTarget;
            if (video.duration > 0) setProgress(video.currentTime / video.duration);
            update({ ms: Math.floor(video.currentTime * 1000) });
            if (Math.abs(video.currentTime - lastSavedRef.current) >= SAVE_EVERY_S) save(video);
          }}
          onEnded={(event) => {
            save(event.currentTarget);
            close();
          }}
          // 来源失效（视频被删、局域网断了）：静静收起，不在角落里留一块黑屏。
          onError={() => close()}
        />
        {audioOnly && (
          <span aria-hidden="true" className="ca-mini-player-audio">
            <AudioLines className="h-6 w-6" />
          </span>
        )}
      </button>
      <div className="ca-mini-player-bar">
        <button
          type="button"
          onClick={() => onReturn(current())}
          className="ca-mini-player-title"
          title={title}
          tabIndex={-1}
        >
          {title}
        </button>
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? t("videoPlayer.pause") : t("videoPlayer.play")}
          title={playing ? t("videoPlayer.pause") : t("videoPlayer.play")}
          className="ca-mini-player-btn ca-hit-expand"
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("miniPlayer.close")}
          title={t("miniPlayer.close")}
          className="ca-mini-player-btn ca-hit-expand"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div aria-hidden="true" className="ca-mini-player-progress">
        <span style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}
