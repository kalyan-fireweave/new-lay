---
paths:
  - "apps/web/**"
---

# Web

The board loads the document once. Navigation inside Keel uses the router. `shouldRevalidate` returns false when the board id is unchanged. Store snapshots passed to `useSyncExternalStore` keep a stable reference.

Fetches send `Accept: application/json`. The Vite proxy sends an HTML request for `/session`, `/boards`, `/cards`, `/search`, `/teams`, `/users`, `/health`, `/ready`, and `/otel` to `index.html`.

Journey labels stay exact: Sign in, Email, Password, Launch, New card, Add, Search, Close, and the column regions Todo, Doing, Done. The card button's accessible name is the title only. The Star control is `type="button"` outside the comment form, labeled Star, then Starred.

The sign-in heading is Sign in. The sign-up heading is Create an account, and its button is Create account. On `/sign-in` and `/sign-up` the shell hides the board header.

After a UI change, open the page and complete the flow: click, type, and submit. A screenshot of the first paint is not the check.
