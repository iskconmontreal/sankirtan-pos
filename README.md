# Sankirtan POS — ISKCON Montréal

A mobile-first Point-of-Sale for the ISKCON Montréal sankirtan (book distribution) program. Devotees log their daily distribution at end of day on a shared device or phone: pick their name, enter qty per book, record the collection amount, submit. Data goes to [Goloka](https://github.com/iskcon-montreal/goloka) via its `/api/sankirtan/*` REST endpoints.

## Quick start

```bash
# Just serve the files — no build step
npx serve .
# or
python3 -m http.server 8000
```

Open `http://localhost:8000`, tap **Admin** → paste your Goloka URL + write key + Google Sheet CSV URL → **Save** → **Test Connection**.

## Admin setup

| Field | Value |
|---|---|
| Goloka URL | e.g. `https://api.iskconmontreal.ca` |
| Sankirtan Write Key | `SANKIRTAN_WRITE_KEY` from Goloka `.env` |

The devotee list is managed by the temple admin in Mandir (Users → assign the **Book Distributor** role).

## GitHub Pages

Repo → Settings → Pages → Deploy from branch → `main` / `(root)`. Live at `https://<org>.github.io/sankirtan-pos/`.

## Stack

Vanilla JS, ES modules, [Sprae](https://github.com/dy/sprae) for reactivity, plain CSS. No build step.
