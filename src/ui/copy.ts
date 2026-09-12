import type { Obstacle, Session } from "../session/state";

export type SessionCopy = {
  readonly title: string;
  readonly body: string;
  readonly primary: string | null;
};

export const COPY: { readonly [K in Session["kind"]]: SessionCopy } = {
  unsupported: {
    title: "このブラウザでは動作しません",
    body: "macOS の Safari または Chrome の最新版で開いてください。音声処理に必要な機能が見つかりませんでした。",
    primary: null,
  },
  idle: {
    title: "周囲の定常ノイズを抑えて聞く",
    body: "ヘッドホンを着用してください。マイクで拾った周囲の音から、エアコンやファンなどの変わらないノイズを取り除いて再生します。耳に直接届く音を打ち消すわけではありません。",
    primary: "ヘッドホンを着用して開始",
  },
  requesting: {
    title: "マイクの使用許可を待っています",
    body: "ブラウザの確認ダイアログで「許可」を選んでください。",
    primary: null,
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

export function obstacleCopy(obstacle: Obstacle): SessionCopy {
  switch (obstacle.kind) {
    case "permission-denied":
      return {
        title: "マイクを使えません",
        body: "Safari では「設定 → ウェブサイト → マイク」から、Chrome ではアドレスバー左のサイト設定から、このサイトのマイクを許可してください。",
        primary: "もう一度試す",
      };
    case "no-input-device":
      return {
        title: "マイクが見つかりません",
        body: "マイクを接続するか、macOS の「システム設定 → サウンド → 入力」で入力装置を選んでください。",
        primary: "もう一度試す",
      };
    case "device-in-use":
      return {
        title: "マイクを独占しているアプリがあります",
        body: "ほかのアプリがマイクを使っていると開始できません。そのアプリを終了してからやり直してください。",
        primary: "もう一度試す",
      };
    case "context-blocked":
      return {
        title: "音声コンテキストを開始できませんでした",
        body: "ページを再読み込みしてから、もう一度ボタンを押してください。",
        primary: "もう一度試す",
      };
    case "engine-failed":
      return {
        title: "音声処理を開始できませんでした",
        body: obstacle.detail,
        primary: "もう一度試す",
      };
  }
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
