# Sankirtan POS — ISKCON Montréal

A mobile-first Point-of-Sale for the ISKCON Montréal sankirtan (book distribution) program. Devotees sign in with their own Goloka account (Google or email+OTP), enter qty per book, record the collection amount, submit. Sessions are attributed to the signed-in devotee server-side. Data goes to [Goloka](https://github.com/iskcon-montreal/goloka) via its `/api/sankirtan/*` REST endpoints.

## Quick start

```bash
# Just serve the files — no build step
npx serve .
# or
python3 -m http.server 8000
```

Open `http://localhost:8000` and sign in. The app talks to the production API (`https://api.iskconmontreal.ca`) by default; to use a local Goloka during development, run this in the browser console:

```js
localStorage.setItem('sankirtan_goloka_url', 'http://localhost:8080'); location.reload()
// remove the key to go back to production:
localStorage.removeItem('sankirtan_goloka_url'); location.reload()
```

## Accounts & roles

There is no sign-up. The temple admin creates each devotee's user in Mandir (Users) with their email and assigns the **Book Distributor** role (`sankirtan:view` to browse + `sankirtan:create` to submit sessions). Google sign-in matches that email; email+OTP works as a fallback. Accounts without the role are refused by the POS.

## GitHub Pages

Repo → Settings → Pages → Deploy from branch → `main` / `(root)`. Live at `https://<org>.github.io/sankirtan-pos/`.

## Stack

Vanilla JS, ES modules, [Sprae](https://github.com/dy/sprae) for reactivity (vendored at `js/vendor/sprae.js`), plain CSS. No build step.
