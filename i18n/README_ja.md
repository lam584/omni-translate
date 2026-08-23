# Omni Translate

<h4 align="center">
    <p>
        <a href="../README.md">简体中文</a> |
        <a href="README_en.md">English</a> |
        <a href="README_es.md">Español</a> |
        <a href="README_ar.md">العربية</a> |
        <a href="README_pt.md">Português</a> |
        <a href="README_ru.md">Русский</a> |
        <a href="README_hi.md">हिन्दी</a> |
        <a href="README_bn.md">বাংলা</a> |
        <a href="README_de.md">Deutsch</a> |
        <a href="README_id.md">Bahasa Indonesia</a> |
        <a href="README_ko.md">한국어</a> |
        <a href="README_fr.md">Français</a> |
        <a href="README_vi.md">Tiếng Việt</a> |
        <b>日本語</b> |
        <a href="README_te.md">తెలుగు</a> |
        <a href="README_ta.md">தமிழ்</a> |
        <a href="README_mr.md">मराठी</a> |
        <a href="README_th.md">ไทย</a> |
        <a href="README_fil.md">Filipino</a> |
        <a href="README_tr.md">Türkçe</a>
    </p>
</h4>

Omni Translate は Windows のリアルタイム音声翻訳シナリオ向けデスクトップアプリです。動画字幕翻訳、ゲーム音声翻訳、音声ルームや会議での双方向翻訳などのワークフローをカバーします。アプリは仮想オーディオドライバー、Native Bridge、Rust Core、統合 AI Gateway を連携させ、システム音声キャプチャ、音声認識、LLM 翻訳、音声合成、字幕レンダリング、音声再生をつなぎます。

## 主な機能

- **リアルタイム字幕翻訳**: システム音声またはマイク音声をキャプチャし、リアルタイムに認識して翻訳字幕を表示します。メインウィンドウとフローティングウィンドウでの表示に対応します。
- **字幕フローティングウィンドウ**: 独立した透明、枠なし、常に最前面のウィンドウで、動画、ゲーム、会議アプリの上に重ねられます。
- **双方向音声翻訳**: 視聴、ゲーム、音声ルームなどのルーティングモードに対応し、入力側の字幕/翻訳音声と出力側の仮想マイク出力をカバーします。
- **仮想オーディオドライバー**: SYSVAD WaveRT ベースの Windows 仮想オーディオドライバーで、IOCTL/共有 ABI によりユーザーモードのブリッジサービスと通信します。
- **Rust Native Bridge**: `apps/bridge-service-native` は現在唯一の本番ブリッジ実装で、WASAPI、Named Pipe IPC、音声フレーム、ドライバー連携を担当します。
- **統合 AI Gateway**: テンプレート化された DashScope と OpenAI 互換インターフェースを統合し、HTTP、streaming HTTP、WebSocket 形式に対応します。
- **用語集管理**: 分野別用語パッケージのインポート、エクスポート、マージ、優先順位ポリシーに対応し、翻訳プロンプトの経路へ注入します。
- **安全な認証情報管理**: API Key などの機密情報は Windows Credential Manager に保存し、業務設定へ平文で書き込みません。
- **診断と品質ゲート**: ドライバーのヘルスプローブ、モデル Trace、ログエクスポート、Watch Mode の実リンクテスト、リリース前品質ゲートを提供します。
- **20 種類の UI 言語**: 現在の UI 言語リソースは `ar`、`bn`、`de`、`en`、`es`、`fil`、`fr`、`hi`、`id`、`ja`、`ko`、`mr`、`pt`、`ru`、`ta`、`te`、`th`、`tr`、`vi`、`zh-CN` をカバーします。

## クイックスタート

### 要件

- **Node.js** >= 20
- **Rust stable**、edition 2021
- **Windows 10/11**
- **Visual Studio 2022 Build Tools + Desktop development with C++**、Tauri desktop shell と Native Bridge をビルドする際に必要です。コマンドラインから `cl.exe` と `link.exe` が見つかる必要があります
- **WDK 10.0.26100**、仮想オーディオドライバーをビルドする場合のみ必要
- 開発用ドライバーの読み込みには Windows TESTSIGNING モードが必要です。通常のフロントエンドプレビューではドライバーや管理者権限は不要です。

### インストールと実行

```bash
# 1. リポジトリをクローン
git clone <repo-url>
cd omni-translate

# 2. package-lock.json に従って依存関係をインストール
npm ci

# 3. フロントエンドのブラウザプレビューを起動
npm run dev:desktop

# 4. 完全な Tauri デスクトップアプリを起動
npm run dev:desktop-shell
```

ブラウザプレビューモードでは自動的に Mock runtime が使われるため、UI 開発やページ確認に適しています。完全なデスクトップアプリは Tauri/Rust runtime を起動し、ドライバーのインストールや修復などの操作が関係する場合だけ昇格フローを実行します。

完全なデスクトップシェルを初めて起動する前に、Visual Studio 2022 の **Developer PowerShell** または **x64 Native Tools Command Prompt** からリポジトリに入ることを推奨します。通常の PowerShell で `link.exe not found` エラーが出る場合は、先に MSVC 環境を読み込んでください。

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1" -Arch amd64 -HostArch amd64
npm run dev:desktop-shell
```

`dev:desktop-shell` はまず release 版 Native Bridge をビルドし、その後 Tauri dev 経由で Vite、Rust Core、デスクトップウィンドウを起動します。スクリプトは UAC を要求します。初回の Rust ビルドは依存関係のダウンロードとコンパイルが必要なため、以降の起動より明らかに時間がかかります。

### よく使うコマンド

| コマンド | 説明 |
| --- | --- |
| `npm run dev:desktop` | React/Vite フロントエンド開発サーバーを起動 |
| `npm run dev:desktop-shell` | 昇格スクリプト経由で完全な Tauri デスクトップアプリを起動 |
| `npm run dev:desktop:fast` | release 版 Native Bridge の再ビルドと昇格をスキップし、Cargo インクリメンタルキャッシュを再利用して日常のデスクトップ連携開発を行う |
| `npm run lint:desktop` | デスクトップフロントエンドの ESLint を実行 |
| `npm run check:desktop` | TypeScript の型チェックを実行 |
| `npm run build:desktop` | フロントエンド成果物をビルド |
| `npm run check:desktop-shell` | Tauri Rust バックエンドをチェック |
| `npm run build:desktop-shell` | 完全な Tauri アプリをビルド |
| `npm run build:bridge-service-native` | Rust Native Bridge Service をビルド |
| `npm run test:all` | 全テスト入口を実行 |
| `npm run test:contracts` | 凍結契約を検証 |
| `npm run test:watch-mode-live:dry-run` | Watch Mode 実リンク dry-run を実行 |
| `npm run quality:gate:auto` | 自動品質ゲートを実行 |
| `npm run quality:gate:release` | リリース品質ゲートを実行 |
| `npm run driver:build-sysvad` | SYSVAD 仮想オーディオドライバーをビルド |
| `npm run driver:install` | 開発用ドライバーをインストール |
| `npm run driver:test` | 開発用ドライバーの状態をプローブ |
| `npm run driver:uninstall` | 開発用ドライバーをアンインストール |
| `npm run release:prepare` | リリース準備パイプラインを実行 |

## システムアーキテクチャ

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    メインウィンドウ、字幕フローティング、ルーティング、設定、 │
│    診断、Provider ページ                                    │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    Tauri commands/events、セッション編成、設定保存、診断、   │
│    トレイ連携                                               │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio、システム音声/マイクキャプチャ、    │
│    VAD、分節、ミキシング                                    │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite、ASR / Translation / TTS Provider   │
│    DashScope と OpenAI 互換テンプレート、能力プローブ、      │
│    エラー正規化                                             │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar、WASAPI、Named Pipe IPC、音声フレーム、      │
│    ドライバー IOCTL                                         │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    SYSVAD WaveRT 仮想オーディオドライバー、インストール、    │
│    ロールバック、修復、ヘルスプローブ                       │
└────────────────────────────────────────────────────────────┘
```

## ディレクトリ構成

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Tauri デスクトップアプリ
│   │   ├── src/                    # React フロントエンド
│   │   │   ├── components/         # 共通 UI コンポーネント
│   │   │   ├── i18n/               # 20 種類の UI 言語リソース
│   │   │   ├── pages/              # セッション、ルーティング、Provider、用語集、設定、診断ページ
│   │   │   ├── runtime/            # フロントエンド runtime/IPC アダプター
│   │   │   ├── schema/             # TypeScript 契約と型
│   │   │   └── stores/             # Zustand 状態
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # 音声エンジン、STT、TTS、翻訳ルーティング、リアルタイム Provider
│   │           ├── bridge/         # Bridge/ドライバーのインストールと IPC 契約
│   │           ├── diagnostics/    # ログ、Trace、診断状態
│   │           ├── provider/       # AI Gateway、Provider テンプレート、HTTP/WS トランスポート
│   │           ├── runtime/        # ウィンドウ、トレイ、ランタイム状態
│   │           └── storage/        # SQLite リポジトリと認証情報管理
│   └── bridge-service-native/      # Rust Native Bridge Service、唯一の本番ブリッジ実装
├── crates/                         # ルート Cargo workspace 共有ライブラリ
│   ├── omni-bridge-protocol/       # Desktop と Native Bridge が共用するパイププロトコル
│   └── omni-logging/               # 共有ノンブロッキングログパイプライン
├── drivers/
│   └── windows-virtual-mic/        # SYSVAD WaveRT 仮想オーディオドライバー
│       ├── include/                # Driver/Bridge 共有 IOCTL ABI
│       ├── package/                # ドライバーパッケージメタデータ
│       └── sysvad/                 # Microsoft SYSVAD サンプルを変更したドライバーソース
├── scripts/
│   ├── development/                # 開発起動スクリプト
│   ├── diagnostics/                # 診断ツール
│   ├── installer/                  # ドライバーのビルド、インストール、アンインストール、修復、プローブ
│   ├── release/                    # リリース検証、manifest、パッケージング、署名リスト
│   └── testing/                    # テスト、カバレッジ、品質ゲート、Watch Mode リンク
├── docs/                           # アーキテクチャ、品質、プロジェクト文書、Provider/API 資料
└── artifacts/                      # ビルド成果物、ログ、診断出力
```

## コアフロー

### 入力翻訳（視聴/字幕シナリオ）

```text
システム音声
  → 仮想オーディオドライバー / WASAPI キャプチャ
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / 分節
  → ASR
  → Translation Provider
  → 字幕レンダリング（メインウィンドウ + フローティング）
  → 任意の TTS
  → ローカルスピーカー / モニター出力
```

### 出力翻訳（音声ルーム/会議/ゲームシナリオ）

```text
マイク
  → Desktop Rust Audio Layer
  → VAD / 分節
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → 仮想オーディオドライバー
  → 対象アプリが仮想マイク / 仮想エンドポイントを読み取る
```

### レイテンシと縮退戦略

- 字幕と翻訳音声は独立したスケジューリング結果であり、字幕が優先して確定されます。
- Provider のレイテンシが予算を超えると `latency-high` が発行され、字幕出力は継続し、TTS は deferred/queued 状態へ移ります。
- Provider プローブがリアルタイム利用に不適合と判断した場合、翻訳音声の重ね合わせは既定で無効化され、字幕優先経路だけが維持されます。
- ドライバーまたは Bridge の異常はアプリ起動をブロックしません。字幕、ローカル再生、診断ページは縮退モードで利用可能なままであるべきです。

## 技術スタック

| レイヤー | 技術 |
| --- | --- |
| フロントエンド | React 19.2.x、TypeScript 6.0.x、Vite 8.x、Rolldown、CSS |
| デスクトップシェル | Tauri 2.x、`@tauri-apps/api`、`@tauri-apps/cli` |
| 状態とルーティング | Zustand 5.x、react-router-dom 7.x |
| 国際化 | i18next 26.x、react-i18next 17.x、i18next-browser-languagedetector |
| フロントエンドテスト | Vitest 4.x、jsdom 29.x、ESLint 10.x |
| Rust runtime | Rust 2021、Serde、Tauri commands/events |
| Provider ネットワーク層 | reqwest 0.13、tungstenite 0.29、rustls |
| ストレージと認証情報 | rusqlite 0.40 bundled SQLite、Windows Credential Manager |
| 音声 | cpal 0.17、rodio 0.22、wasapi 0.23、hound |
| システムインターフェース | windows-sys 0.61 |
| Native Bridge | Rust sidecar、WASAPI、Named Pipe、IOCTL ABI |
| ドライバー | Windows SYSVAD WaveRT 仮想オーディオドライバー |
| スクリプト | PowerShell、Node.js release/testing scripts |

## 契約とデータ境界

プロジェクトは現在、4 種類の凍結契約を重点的に維持しています。

1. **Provider Contract**: Provider メタデータ、認証参照、リクエストパラメーター、ストリーミングイベント、エラー構造、能力プローブ結果。
2. **Audio Contract**: システム音声、マイク、PCM フレーム、分節、ミキシング、レイテンシ補正、Push-to-talk 状態。
3. **Driver Bridge Contract**: Desktop、Native Bridge、ドライバー間の初期化、音声フレーム、状態問い合わせ、エラーイベント、終了プロトコル。
4. **OBS Integration Contract**: 将来の OBS 字幕オーバーレイとシーントリガー対応に備えた接続と出力の境界。

構造化設定は SQLite を主な真実のソースとして使用します。機密認証情報は Windows Credential Manager に保存します。ログ、キャッシュ、用語集パッケージ、一時音声ファイルはディレクトリごとに分離されます。

## 品質とテスト

- `npm run verify:desktop`: デスクトップフロントエンドの lint、typecheck、test、build。
- `npm run test:desktop-shell`: Tauri Rust バックエンドテスト。
- `npm run test:bridge-service-native`: Native Bridge Rust テスト。
- `npm run test:contracts`: TypeScript/Rust/スクリプト側の凍結契約を検証。
- `npm run quality:gate:auto`: 自動品質ゲート。
- `npm run quality:gate:release`: 手動検証入口を含むリリース前品質ゲート。
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode レポート、証跡、実リンクテスト入口。

## 開発

### フロントエンド開発

フロントエンドは `npm run dev:desktop` を使ってブラウザで直接開発できます。非 Tauri 環境では runtime 層が Mock データを返すため、ドライバーをインストールせず、Rust バックエンドを起動しなくてもページや操作を確認できます。

### デスクトップシェルの開発とテスト

`invoke`、event、SQLite、Windows Credential Manager、Native Bridge、システム音声、字幕フローティングウィンドウに関わる作業では、必ず Tauri デスクトップシェル内でテストする必要があり、ブラウザの Mock プレビューでは代替できません。

```powershell
# 初回起動時、または Rust Core、Native Bridge、Cargo 設定を変更した場合
npm run dev:desktop-shell

# 標準ビルドを一度成功させた後の日常的なフロントエンド/デスクトップ連携
npm run dev:desktop:fast
```

`dev:desktop:fast` は `dev:desktop-shell` が実行する release 版 Native Bridge の再ビルドと UAC 昇格をスキップし、まずポート `4173` の Vite サービスを起動・プリウォームしてから `tauri dev` に入り、Cargo インクリメンタルキャッシュを再利用します。debug EXE を直接実行することはできません。Tauri CLI が WebView IPC に必要なランタイムコンテキストも提供しているためです。初回実行時、Native Bridge のソースを変更した後、または昇格フローを検証する必要がある場合は、引き続き `dev:desktop-shell` を使用してください。

デスクトップシェル起動後、「診断」ページで少なくとも以下の項目を確認してください。

- `isTauri`、`IPC Bridge`、`window.ipc`、`isTauriRuntime` がすべて `true` であること。
- ブリッジ状態が `tauri-shell` であり、正規化された環境状態が `runtime-error` ではないこと。
- ストレージ状態が `ready` であり、Schema バージョンが `1` 以上、認証情報バックエンドが `browser-preview` ではないこと。
- `artifacts/diagnostics/logs/app.log` に `debug_ipc_ping` が出力され、起動後に `startup.ipc_watchdog_reload` が発生していないこと。

Rust チェックを実行する前にデスクトップ開発プロセスを終了し、実行中の `tauri dev` が長時間 Cargo ビルドロックを占有しないようにしてください。

### Rust デスクトップシェル

```bash
npm run check:desktop-shell
npm run test:desktop-shell
npm run build:desktop-shell
```

### Native Bridge

```bash
npm run check:bridge-service-native
npm run test:bridge-service-native
npm run build:bridge-service-native
```

### ドライバー開発

ドライバーのビルドには Visual Studio 2022 + WDK が必要です。開発用ドライバーのインストールには管理者権限と TESTSIGNING モードが必要です。

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## ライセンス

本プロジェクトは [Apache License 2.0](../LICENSE) の下で提供されます。
