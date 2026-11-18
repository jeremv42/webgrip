# WebGrip

Mini-DataGrip web en TypeScript : Node (Express, `pg`, `mysql2`) + Vue 3 / Vuetify, sans store.

- Accès protégé par un mot de passe (`WEBGRIP_PASSWORD`), session gardée 30 jours par un cookie
- Connexions PostgreSQL et MariaDB/MySQL, enregistrées chiffrées (AES-256-GCM, clé `WEBGRIP_SECRET`) dans `data/connections.json`
- Arbre bases → schémas (Postgres) → tables/vues → colonnes, filtre, double-clic sur une table = `SELECT * … LIMIT n`
- Éditeur Monaco (celui de VS Code) avec un vrai parseur SQL : autocomplétion selon le contexte (tables de tous les schémas, colonnes typées, alias, sous-requêtes, CTE, mots-clés, fonctions), erreurs de syntaxe soulignées, formatage (Ctrl+Alt+F)
  - **Ctrl+Entrée** : sélection, sinon requête sous le curseur
  - **Ctrl+Maj+Entrée** : tout le script
- Un onglet de résultat par requête ; arrêt à la première erreur (le curseur est placé sur l'erreur si Postgres donne la position)
- Grille : tri par colonne, NULL distincts, double-clic sur une cellule = valeur complète (JSON indenté), copie TSV
- Une session dédiée par base pour l'éditeur (les `BEGIN`/`SET`/tables temporaires persistent entre exécutions) ; bouton Annuler (`pg_cancel_backend` / `KILL QUERY`)
- Lignes limitées (100 à 20 000) : les lignes en trop ne sont pas chargées (curseur côté Postgres, streaming côté MariaDB)

## Lancer

```bash
cp .env.example .env             # puis y mettre WEBGRIP_PASSWORD et WEBGRIP_SECRET (openssl rand -base64 32)
npm install
npm run dev                      # Vite + API en watch, sur Tailscale et localhost (voir ci-dessous)
npm run build && npm start       # http://localhost:5180 (vite preview du build)
```

Node ≥ 23.6 : l'API (`server/*.ts`) est exécutée directement, sans étape de compilation (type stripping).

## Vérifier

```bash
npm run typecheck                # vue-tsc (SPA) + tsc (API)
npm run lint                     # oxlint
npm run format                   # oxfmt (format:check pour vérifier seulement)
npm test                         # Vitest (test:watch en continu)
npm run check                    # tout ce qui précède
```

Tout passe par le port de Vite (5180) : il sert le front et proxifie `/api` vers le backend,
qui n'écoute que sur `127.0.0.1:3070` (jamais exposé).

En dev, Vite écoute sur l'IP Tailscale (interface `tailscale0`)
et reste joignable sur http://localhost:5180 (redirection locale) ; aucune autre interface n'est ouverte.
Sans Tailscale, il retombe sur localhost seul. `npm start` (preview) reste sur localhost.

Variables (environnement ou `.env`, ignoré par git) : `WEBGRIP_PASSWORD` (mot de passe d'accès), `WEBGRIP_SECRET` (clé de
chiffrement des connexions et des cookies, 16 caractères au moins : la perdre, c'est perdre les connexions enregistrées),
`WEB_PORT` (port de Vite, 5180), `PORT` (port interne de l'API, 3070), `WEBGRIP_DATA` (chemin du fichier de connexions).
Un ancien fichier de connexions en clair est chiffré au premier démarrage. Changer `WEBGRIP_PASSWORD` déconnecte toutes les sessions.
