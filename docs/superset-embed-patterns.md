# Superset ダッシュボード埋め込みパターン比較

Angular + Superset Embedded SDK を使ったダッシュボード埋め込みの実装パターンと、iframe サイズ制御の方法をまとめる。

---

## 全体アーキテクチャ

```
Angular (localhost:4200)
  └─ SupersetService.getGuestToken()
       └─ HTTP GET → NestJS BFF (localhost:3000)
                        └─ POST /api/v1/security/login       → Superset (localhost:8088)
                        └─ GET  /api/v1/security/csrf_token/ → Superset
                        └─ POST /api/v1/security/guest_token/ → Superset
                             ↓ guest token
  └─ embedDashboard() ... @superset-ui/embedded-sdk
       └─ iframe を mountPoint に挿入 → Superset ダッシュボードを表示
```

### なぜ BFF が必要か

Superset の `guest_token` API は **admin 権限の `access_token` と CSRF トークンが必要**。
これらを Angular から直接取得すると admin 認証情報がブラウザに露出するため、BFF がサーバーサイドで代理取得する。

### BFF の処理フロー

```
1. POST /api/v1/security/login
     → { access_token }

2. GET /api/v1/security/csrf_token/  (Authorization: Bearer <access_token>)
     → { result: csrfToken }  +  Set-Cookie: session=...

3. POST /api/v1/security/guest_token/
     (Authorization + X-CSRFToken + Cookie: session)
     body: { resources: [{ type: "dashboard", id: "<embedded-uuid>" }], rls: [], user: {...} }
     → { token: "<guest_token>" }
```

> **注意**: `guest_token` API に渡す `id` は **Embedded UUID**（ダッシュボードの整数IDやdashboard UUIDとは別物）。
> Superset 管理画面 または `POST /api/v1/dashboard/{id}/embedded` で埋め込みを有効化したときに発行される。

---

## embedDashboard() の挙動

`@superset-ui/embedded-sdk` の `embedDashboard()` は以下を行う。

1. `mountPoint` の DOM に `<iframe>` を挿入する
2. iframe の `src` に guest token を付与した Superset の URL をセットする
3. SDK が内部で iframe と postMessage 通信し、トークン期限切れ時に `fetchGuestToken` コールバックを呼ぶ

**重要**: SDK は iframe に **固定ピクセルサイズ**（例: `width: 800px; height: 600px`）を HTML 属性として直接設定する。
そのため CSS で `width: 100%; height: 100%` を指定しただけでは上書きされず、`!important` が必要になる。

---

## iframe サイズ制御の 3 パターン比較

### パターン1: RxJS (ResizeObserver + Observable)

**ファイル**: `pages/rxjs-dashboard/rxjs-dashboard.component.ts`

```typescript
// ResizeObserver を RxJS Observable に変換
function fromResizeObserver(target: Element): Observable<ResizeObserverEntry> {
  return new Observable((subscriber) => {
    const observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => subscriber.next(entry));
    });
    observer.observe(target);
    return () => observer.disconnect(); // unsubscribe 時に自動切断
  });
}

// パイプラインの Step 4
switchMap((ctx) =>
  fromResizeObserver(ctx.mountPoint).pipe(
    debounceTime(100),                    // 100ms デバウンス
    distinctUntilChanged(
      (a, b) => a.width === b.width && a.height === b.height,
    ),
    tap(({ width, height }) => {
      if (ctx.iframe) {
        ctx.iframe.style.width = `${width}px`;  // SDK の固定値を JS で上書き
        ctx.iframe.style.height = `${height}px`;
      }
    }),
  ),
),
```

**特徴**

| 項目 | 内容 |
|------|------|
| リサイズ検知 | ResizeObserver → Observable |
| DOM 更新タイミング | RxJS パイプライン内で直接 (`tap`) |
| チューニング | `debounceTime` / `distinctUntilChanged` で頻度制御可 |
| クリーンアップ | `takeUntil(destroy$)` で自動解除、Observable のティアダウンで `disconnect()` |
| 向いているケース | すでに RxJS を多用しているプロジェクト、リサイズに細かい制御が必要な場合 |

---

### パターン2: Angular Lifecycle Signals (ResizeObserver + Signal)

**ファイル**: `pages/lifecycle-dashboard/lifecycle-dashboard.component.ts`

```typescript
// Signal: ResizeObserver がサイズを書き込む
private readonly iframeSize = signal<{ width: number; height: number } | null>(null);

constructor() {
  // afterNextRender: DOM 確定後に一度だけ実行 (AfterViewInit の代替)
  afterNextRender(() => { void this.initDashboard(); });

  // afterRenderEffect: iframeSize Signal が変化した描画サイクルで自動再実行
  afterRenderEffect(() => {
    const size = this.iframeSize(); // ← Signal を参照するだけで依存が自動登録
    if (this.iframeEl && size) {
      this.iframeEl.style.width  = `${size.width}px`;
      this.iframeEl.style.height = `${size.height}px`;
    }
  });
}

// initDashboard() 内
this.resizeObserver = new ResizeObserver((entries) => {
  const rect = entries[0]?.contentRect;
  if (rect) {
    this.iframeSize.set({ width: rect.width, height: rect.height }); // Signal に書くだけ
  }
});
this.resizeObserver.observe(mountPoint);
```

**責務の分離**

```
ResizeObserver コールバック  →  Signal への書き込みのみ
afterRenderEffect            →  DOM への反映のみ
```

Angular の描画サイクルと同期した安全なタイミングで DOM を操作できる。

**特徴**

| 項目 | 内容 |
|------|------|
| リサイズ検知 | ResizeObserver → Signal |
| DOM 更新タイミング | `afterRenderEffect`（Angular 描画サイクルに同期） |
| チューニング | デバウンスは自前実装が必要 |
| クリーンアップ | `DestroyRef.onDestroy` でコールバック登録（`OnDestroy` インターフェース不要） |
| 向いているケース | Angular 17+ の新スタイルに統一したいプロジェクト |

---

### パターン3: CSS 制御のみ (ResizeObserver 不使用)

**ファイル**: `pages/css-dashboard/css-dashboard.component.ts` / `.scss`

```typescript
// JS 側: リサイズ処理なし。embedDashboard() 後に isLoading を false にするだけ
tap(() => {
  this.isLoading.set(false);
  this.currentStep.set('done');
}),
```

```scss
// CSS 側: SDK が注入する固定ピクセルを !important で上書き
.dashboard-container {
  width: 100%;
  height: 100%;

  ::ng-deep iframe {
    width: 100% !important;   // SDK の style 属性を上書き
    height: 100% !important;
    border: none;
    display: block;
  }
}
```

**なぜ動くか**

SDK は `iframe.style.width = "800px"` のようにインラインスタイルを設定するが、
CSS の `!important` はインラインスタイルよりも優先される（specificity の例外）。
そのため JS による ResizeObserver 処理が不要になる。

**特徴**

| 項目 | 内容 |
|------|------|
| リサイズ検知 | 不要（ブラウザの CSS レイアウトエンジンに委ねる） |
| DOM 更新タイミング | ブラウザが自動処理 |
| チューニング | CSS のみで完結 |
| クリーンアップ | ResizeObserver がないため不要 |
| 向いているケース | シンプルさを優先する場合、コンテナサイズが CSS で確定している場合 |

---

## 3パターンの総合比較

| | RxJS パターン | Lifecycle Signals | CSS 制御 |
|--|--|--|--|
| コード量 | 多い | 中程度 | 少ない |
| JS での制御 | 細かく可能 | Angular サイクル依存 | なし |
| デバウンス | `debounceTime` で簡単 | 自前実装が必要 | 不要 |
| Angular バージョン依存 | 低 | 17+ 推奨 | なし |
| 購読解除の明示性 | `takeUntil` が必要 | `DestroyRef` で自動 | 不要 |
| `!important` 依存 | なし（JS で上書き） | なし（JS で上書き） | あり |

### 結論

- **シンプルさ優先** → CSS 制御パターン
- **細かいリサイズ制御が必要**（アニメーション、最小幅制御など）→ RxJS パターン
- **Angular 17+ の新スタイルに統一** → Lifecycle Signals パターン

---

## Superset 側の必要設定

### 1. ダッシュボードの埋め込み有効化

```bash
# admin トークン取得
ACCESS_TOKEN=$(curl -s -X POST 'http://localhost:8088/api/v1/security/login' \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin","provider":"db"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

CSRF_TOKEN=$(curl -s -X GET "http://localhost:8088/api/v1/security/csrf_token/" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -c /tmp/cookies.txt \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result'])")

# 対象ダッシュボードを埋め込み有効化 (dashboard ID は整数)
curl -X POST "http://localhost:8088/api/v1/dashboard/{ID}/embedded" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-CSRFToken: $CSRF_TOKEN" \
  -H "Content-Type: application/json" \
  -b /tmp/cookies.txt \
  -d '{"allowed_domains": []}'
# → { "result": { "uuid": "<embedded-uuid>" } }  ← これを dashboardId として使う
```

### 2. `superset_config.py` の必須設定

```python
FEATURE_FLAGS = {
    "EMBEDDED_SUPERSET": True,  # 必須
}

# iframe 埋め込み許可
HTTP_HEADERS: dict = {}
TALISMAN_ENABLED = False  # X-Frame-Options を無効化

# CORS (Angular フロントエンドのオリジンを許可)
CORS_OPTIONS = {
    "supports_credentials": True,
    "allow_headers": ["*"],
    "resources": ["*"],
    "origins": ["http://localhost:4200"],
}

# guest token の JWT audience を Superset の公開 URL に合わせる
GUEST_TOKEN_JWT_AUDIENCE = "http://localhost:8088"
```
