import type { Obstacle, Session } from "../session/state";
import type { AudioRoute } from "../audio/sinks";

export type SessionCopy = {
  readonly title: string;
  readonly body: string;
  readonly primary: string | null;
  readonly secondary?: string;
};

export const COPY: { readonly [K in Session["kind"]]: SessionCopy } = {
  unsupported: {
    title: "このブラウザでは動作しません",
    body: "macOS の Safari または Chrome の最新版で開いてください。音声処理に必要な機能が見つかりませんでした。",
    primary: null,
  },
  idle: {
    title: "周囲の定常ノイズを抑えて聞く",
    body: "会議のマイクにするには、BlackHole などの仮想デバイスを入れたうえで Chrome を使ってください。Zoom や Meet のマイク入力には、Hush が使うその仮想デバイスを選んでください。ヘッドホンは会議アプリのスピーカーのまま使います。自分の耳で聞く場合は、下のヒアスルーを使います。",
    primary: "会議のマイクとして開始",
    secondary: "ヘッドホンへヒアスルー",
  },
  requesting: {
    title: "マイクの使用許可を待っています",
    body: "ブラウザの確認ダイアログで「許可」を選んでください。",
    primary: null,
  },
  "choosing-sink": {
    title: "仮想マイクを選ぶ",
    body: "使う仮想デバイスを選んでください。Zoom や Meet のマイク入力にも、同じ名前を指定します。",
    primary: "中止",
  },
  blocked: {
    title: "開始できませんでした",
    body: "下の説明に従って設定を確認してから、もう一度お試しください。",
    primary: "もう一度試す",
  },
  calibrating: {
    title: "この部屋のノイズを学習しています",
    body: "3秒間、できるだけ静かにしてください。話し声や物音が入ると学習の精度が下がります。このあいだは再生しません。",
    primary: "中止",
  },
  active: {
    title: "稼働中",
    body: "抑制の強さを調整できます。ボタンを押している間は処理前の音が聞こえるので、効果をその場で比べられます。",
    primary: "停止",
  },
};

const RETRY = "もう一度試す";

const STATIC_OBSTACLE: {
  readonly [K in Exclude<Obstacle["kind"], "engine-failed" | "sink-failed">]: SessionCopy;
} = {
  "permission-denied": {
    title: "マイクを使えません",
    body: "Safari では「設定 → ウェブサイト → マイク」から、Chrome ではアドレスバー左のサイト設定から、このサイトのマイクを許可してください。",
    primary: RETRY,
  },
  "no-input-device": {
    title: "マイクが見つかりません",
    body: "マイクを接続するか、macOS の「システム設定 → サウンド → 入力」で入力装置を選んでください。",
    primary: RETRY,
  },
  "device-in-use": {
    title: "マイクを独占しているアプリがあります",
    body: "ほかのアプリがマイクを使っていると開始できません。そのアプリを終了してからやり直してください。",
    primary: RETRY,
  },
  "context-blocked": {
    title: "音声コンテキストを開始できませんでした",
    body: "ページを再読み込みしてから、もう一度ボタンを押してください。",
    primary: RETRY,
  },
  "no-loopback": {
    title: "仮想マイクが見つかりません",
    body: "BlackHole（https://existential.audio/blackhole/）をインストールし、Chrome を再起動してからもう一度試してください。会議の出力先に Multi-Output Device は使わないでください。",
    primary: RETRY,
  },
  "sink-unsupported": {
    title: "このブラウザでは会議マイクにできません",
    body: "会議マイクには macOS の最新 Chrome が必要です。Safari では出力先を切り替えられません。",
    primary: RETRY,
  },
};

export function obstacleCopy(obstacle: Obstacle): SessionCopy {
  if (obstacle.kind === "engine-failed") {
    return { title: "音声処理を開始できませんでした", body: obstacle.detail, primary: RETRY };
  }
  if (obstacle.kind === "sink-failed") {
    return { title: "仮想マイクへ出力できませんでした", body: obstacle.detail, primary: RETRY };
  }
  return STATIC_OBSTACLE[obstacle.kind];
}

export function liveSessionCopy(route: AudioRoute): SessionCopy {
  if (route.kind === "meeting") {
    return {
      title: COPY.active.title,
      body: `Zoom / Meet のマイク入力に「${route.sink.label}」を選んでください。ヘッドホンは会議アプリのスピーカーのまま使います。`,
      primary: COPY.active.primary,
    };
  }
  return COPY.active;
}

export function latencyCopy(latencyMs: number): string {
  const rounded = Math.max(1, Math.round(latencyMs));
  return `遅延は約 ${rounded} ms です。音を打ち消しているのではなく、処理したマイク音を再生しています。`;
}

export function missingLabel(name: "audio-context" | "audio-worklet" | "get-user-media"): string {
  if (name === "audio-context") {
    return "AudioContext";
  }
  if (name === "audio-worklet") {
    return "AudioWorklet";
  }
  return "マイク入力";
}
