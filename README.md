# ブラウザアプリケーションのセキュリティ注意点

## 1. XSS（クロスサイトスクリプティング）

**一次情報**: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html

**リスク**: ユーザー入力や外部データをそのまま DOM に流し込むと悪意あるスクリプトが実行される。

**解決策**:

```js
// NG
element.innerHTML = userInput

// OK
element.textContent = userInput        // テキストのみ
element.setAttribute('class', value)   // 属性は setAttribute

// HTML を挿入する場合は DOMPurify でサニタイズ
import DOMPurify from 'dompurify'
element.innerHTML = DOMPurify.sanitize(userInput)
```

---

## 2. CSRF（クロスサイトリクエストフォージェリ）

**一次情報**: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html

**リスク**: 認証済みユーザーに意図しないリクエストを送らせる。

**解決策**:
- CSRF トークンをリクエストヘッダーに付与（今回の BFF でも `X-CSRFToken` で実装済み）
- `SameSite=Lax` or `Strict` Cookie 属性（今回の設定で対応済み）

---

## 3. CSP（Content Security Policy）

**一次情報**: https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html

**リスク**: XSS が起きた際の被害拡大、外部スクリプトの読み込み。

**解決策**（サーバーのレスポンスヘッダーに設定）:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{random}';
  frame-src http://localhost:8088;   ← Superset の iframe を許可
  object-src 'none';
  base-uri 'none';
```

---

## 4. クリックジャッキング

**一次情報**: https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html

**リスク**: 自分のサイトが悪意ある iframe に埋め込まれて操作される。

**解決策**:

```
X-Frame-Options: SAMEORIGIN
```

または CSP で:

```
Content-Security-Policy: frame-ancestors 'self'
```

---

## 5. 認証トークンの管理

**一次情報**: https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html

**リスク**: JWT を `localStorage` に保存すると XSS で盗まれる。

**解決策**:

```js
// NG
localStorage.setItem('token', jwt)

// OK
// HttpOnly Cookie に保存（JS からアクセス不可）
```

> 今回のゲストトークンはメモリ上のみで使い捨てなので問題なし。

---

## 6. 依存ライブラリの脆弱性

**一次情報**: https://owasp.org/Top10/2021/ （A06）

**解決策**:

```sh
npm audit          # 脆弱性チェック
npm audit fix      # 自動修正
```

---

## 今回の実装における対応状況

| 項目     | 状態                                   |
|--------|--------------------------------------|
| XSS    | 数値のみ DOM 操作、安全                       |
| CSRF   | `X-CSRFToken` 実装済み                   |
| Cookie | `SameSite=Lax` 設定済み                  |
| JWT    | メモリ使い捨て、安全                           |
| CSP    | 未設定（本番前に要対応）                         |
| 認証     | BFF エンドポイントが未認証（本番前に要対応）             |
