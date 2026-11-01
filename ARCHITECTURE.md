# Architecture

WebGrip est un client SQL web minimal (PostgreSQL et MariaDB/MySQL) : une SPA Vue qui parle en JSON à une petite API Node.
Le code (TypeScript) tient en ~2 700 lignes hors tests, sans base de données propre ni store front-end.

## Technologies

| Couche | Techno | Rôle |
|---|---|---|
| Backend | **Node.js** (ESM, TypeScript exécuté directement), **Express 5** | API REST JSON |
| | **pg** + **pg-cursor** | Driver PostgreSQL ; le curseur ne lit que `maxRows + 1` lignes |
| | **mysql2** | Driver MariaDB/MySQL ; les lignes sont lues en flux (streaming), seules les `maxRows` premières sont gardées |
| Front-end | **Vue 3** (`<script setup>`, Composition API) | SPA, état local aux composants, pas de Pinia ni de router |
| | **Vuetify 4** (+ `vite-plugin-vuetify` en auto-import, icônes `@mdi/font`) | Composants UI, thème clair/sombre |
| | **Monaco Editor** (cœur + fonctionnalités, sans les langages intégrés) | Éditeur SQL : raccourcis, menu, recherche… |
| | **monaco-sql-languages** + **dt-sql-parser** (grammaires ANTLR PostgreSQL / MySQL, dans un web worker) | Coloration, erreurs de syntaxe, autocomplétion selon le contexte, formatage (`sql-formatter`) |
| | **patch-package** | Correctif local de `dt-sql-parser` (`patches/`), réappliqué à chaque `npm install` |
| Outillage | **Vite 8** | Serveur de dev, build, `preview` et proxy `/api` |
| | **concurrently** | Lance l'API et Vite ensemble (`npm run dev` / `npm start`) |
| | **TypeScript** (`vue-tsc` pour la SPA, `tsc` pour l'API) | Vérification de types seulement (`npm run typecheck`) : Vite compile le front, Node retire les types de l'API |
| | **oxlint** / **oxfmt** (oxc) | Lint (`npm run lint`) et formatage (`npm run format`) |
| | **Vitest** (+ `@vue/test-utils`, `happy-dom`) | Tests unitaires et de composants (`npm test`) |

## Arborescence

```
webgrip/
├── server/                    Backend (API seule, n'écoute que sur 127.0.0.1:3070), exécuté tel quel par Node (type stripping)
│   ├── index.ts               Point d'entrée : lit l'environnement et écoute
│   ├── app.ts                 createApp() Express : routes, connexions enregistrées, cache des drivers
│   ├── describe.ts            Export de structure en Markdown (pour coller dans un chat)
│   └── drivers/
│       ├── types.ts           Interface Driver commune
│       ├── postgres.ts        PostgresDriver
│       └── mariadb.ts         MariadbDriver
├── shared/
│   ├── types.ts               Types échangés en JSON entre l'API et la SPA (connexions, résultats, complétion…)
│   └── splitSql.ts            Découpage d'un script SQL en requêtes (utilisé par le serveur ET l'éditeur)
├── client/                    Front-end (racine Vite)
│   ├── index.html
│   └── src/
│       ├── main.ts            Création de l'app Vue + Vuetify (thème, valeurs par défaut des composants)
│       ├── App.vue            Mise en page et état global : connexion, base/schéma courants, exécution
│       ├── api.ts             fetch JSON, quoting des identifiants, petit wrapper localStorage
│       ├── grid.ts            Grille : détection des nombres, tri, export TSV
│       ├── style.css
│       ├── components/
│       │   ├── ConnectionDialog.vue   Création / édition / test / suppression d'une connexion
│       │   ├── DbTree.vue             Arbre bases → schémas → tables → colonnes (chargement à la demande)
│       │   ├── SqlEditor.vue          Wrapper Monaco (v-model, Ctrl+Entrée, Ctrl+Maj+Entrée) et autocomplétion
│       │   ├── ResultPanel.vue        Un onglet par requête exécutée (lignes, commande, erreur, ignorée)
│       │   └── ResultGrid.vue         Grille HTML : tri, NULL, valeur complète au double-clic, copie TSV
│       └── sql/
│           ├── sources.ts             Autocomplétion sans Monaco : noms, index du schéma, tables lues par la requête
│           ├── pgsql.worker.ts        Point d'entrée du worker du parseur PostgreSQL
│           └── mysql.worker.ts        Point d'entrée du worker du parseur MySQL/MariaDB
├── patches/                   Correctifs patch-package des dépendances
├── **/*.test.ts               Tests Vitest, à côté du code testé
├── data/connections.json      Connexions enregistrées (créé à l'exécution, ignoré par git)
├── dist/                      Build du front (`npm run build`)
├── tsconfig*.json             tsconfig.app.json (SPA, vue-tsc) et tsconfig.node.json (API, outillage)
├── .oxlintrc.json / .oxfmtrc.json   Lint (oxlint) et formatage (oxfmt)
├── vitest.config.ts           Tests (racine du projet, contrairement à Vite)
└── vite.config.ts             Proxy /api, écoute Tailscale + localhost, alias Monaco, build
```

## Réseau

```
navigateur ──► Vite :5180 ──(/api/*)──► API Express 127.0.0.1:3070 ──► PostgreSQL / MariaDB
                 └── sert la SPA (dev : sources à la volée, preview : dist/)
```

- Un seul port côté navigateur : Vite sert le front et proxifie `/api` vers le backend, qui n'est **jamais** exposé (adresse `127.0.0.1` codée en dur).
- En `npm run dev`, Vite écoute sur l'IP de l'interface `tailscale0` ; un petit plugin (`localhostForward` dans `vite.config.ts`) redirige `127.0.0.1:5180` vers cette adresse pour garder `localhost` utilisable. `allowedHosts` autorise le nom de la machine et `*.ts.net` (MagicDNS). Sans Tailscale, Vite reste sur localhost.
- `npm start` = API + `vite preview` du build, sur localhost uniquement.
- Variables : `WEB_PORT` (5180), `PORT` (port interne de l'API, 3070), `WEBGRIP_DATA` (fichier des connexions).

## Backend

### API

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/connections` | Liste des connexions (sans mot de passe, `hasPassword` à la place) |
| POST | `/api/connections` | Crée ou modifie (mot de passe vide + `keepPassword` = garder l'ancien) |
| DELETE | `/api/connections/:id` | Supprime et ferme le driver |
| POST | `/api/connections/test` | Teste une configuration (renvoie la version du serveur) |
| GET | `/api/c/:id/info` | `{ hasSchemas, databases }` |
| GET | `/api/c/:id/schemas?db=` | Schémas (Postgres ; liste vide pour MariaDB) |
| GET | `/api/c/:id/tables?db=&schema=` | Tables et vues avec leur type |
| GET | `/api/c/:id/columns?db=&schema=&table=` | Colonnes : nom, type, not null, clé primaire |
| GET | `/api/c/:id/completion?db=&schema=` | `{ current, schemas, tables: [{ schema, name, kind, columns: [{ name, type, pk }] }], functions }` pour l'autocomplétion (tous les schémas/bases utilisateur) |
| GET | `/api/c/:id/describe?db=&schema=` | `{ markdown }` : moteur, version, tables/vues avec colonnes, clés, clés étrangères et index (structure seule, aucune donnée) |
| POST | `/api/c/:id/query` | `{ db, schema, sql, maxRows }` → `{ results: [...] }` |
| POST | `/api/c/:id/cancel` | `{ db }` : annule la requête en cours |

Les erreurs sont renvoyées en `4xx` avec `{ error }`. Les erreurs SQL, elles, font partie du résultat (`kind: 'error'`).

### Drivers

`app.ts` crée paresseusement un driver par connexion enregistrée et le jette quand la connexion est modifiée ou supprimée. Les deux drivers implémentent l'interface `Driver` (`server/drivers/types.ts`) :

```
hasSchemas
test() · databases() · schemas(db) · tables(db, schema) · columns(db, schema, table) · completion(db, schema)
run(db, schema, statements, maxRows) · cancel(db) · close()
```

Chaque driver gère deux types de connexions :

- **Métadonnées** : un petit pool (Postgres : un pool par base, car une connexion Postgres est liée à une base ; MariaDB : un pool unique, les requêtes nomment la base).
- **Session de l'éditeur** : une connexion dédiée par base, qui exécute les requêtes l'une après l'autre. Les `BEGIN`, `SET` et tables temporaires persistent donc d'une exécution à l'autre, comme dans DataGrip. Une seule exécution à la fois par session (`busy`) ; l'annulation passe par le pool de métadonnées (`pg_cancel_backend(pid)` / `KILL QUERY threadId`).

Particularités :

- **Postgres** : les valeurs sont renvoyées telles que le serveur les envoie en texte (aucune conversion en `Date`, nombre ou JSON), ce qui garde les dates, `numeric`, `int8` et `bytea` exacts. Les requêtes qui renvoient des lignes (`SELECT`, `WITH`, `VALUES`, `SHOW`, `EXPLAIN`…) passent par un curseur ; les autres par une requête simple. Le schéma choisi est appliqué via `SET search_path`. Les `NOTICE` sont collectées par requête. Les noms de types viennent de `pg_type` (mis en cache).
- **MariaDB** : options `dateStrings`, `bigNumberStrings`, `jsonStrings` pour garder des valeurs textuelles ; les BLOB sont convertis en `0x…`. La session est ouverte directement sur la base choisie. Les warnings sont récupérés via `SHOW WARNINGS`.

### Format d'un résultat

```js
{ sql, start, end, ms, notices,
  kind: 'rows',    columns: [{ name, type }], rows: [[...]], truncated, total? }
| { kind: 'command', command, affected, info? }
| { kind: 'error',   error: { message, detail?, hint?, code?, position? } }
| { kind: 'skipped' }            // après une erreur, les requêtes suivantes ne sont pas exécutées
```

Les lignes sont des tableaux (pas des objets) pour supporter les noms de colonnes en double. `start`/`end` sont les positions de la requête dans le texte envoyé : le front s'en sert, avec `error.position`, pour placer le curseur sur l'erreur.

## Découpage SQL (`shared/splitSql.ts`)

Un seul module, importé par le serveur (pour exécuter requête par requête) et par l'éditeur (pour trouver la requête sous le curseur). Il coupe sur `;` en ignorant ceux situés dans les chaînes `'…'`, identifiants `"…"` / `` `…` ``, commentaires `--`, `#` (MariaDB) et `/* */`, et blocs `$tag$…$tag$` (Postgres). Il renvoie `{ sql, start, end }` pour chaque requête.

## Éditeur et autocomplétion (`SqlEditor.vue`)

- **Chargement** : le cœur de Monaco et ses fonctionnalités, plus les langages `pgsql` / `mysql` de monaco-sql-languages (importés par chemins profonds : l'index du paquet chargerait les grammaires de tous les dialectes). Les parseurs (≈ 2,2 Mo chacun) tournent dans un web worker, chargé seulement pour le dialecte utilisé.
- **Adaptation à Monaco ≥ 0.53** : monaco-sql-languages utilise encore les anciens chemins (`monaco-editor/esm/vs/...`) et l'ancienne API de workers (`createWebWorker({ moduleId, label, createData })`). Des alias dans `vite.config.ts` résolvent les chemins, et `SqlEditor.vue` enveloppe `monaco.editor.createWebWorker` pour fournir le `Worker` (`client/src/sql/*.worker.ts`) et lui envoyer `createData`.
- **Complétion** : à chaque demande, le parseur indique ce que la grammaire attend au curseur (table, colonne, fonction, base… et les mots-clés valides) et les entités de la requête (tables, alias, sous-requêtes, CTE). Le `completionService` les croise avec le schéma renvoyé par `/completion` :
  - tables de tous les schémas (non qualifiées pour le schéma courant), schémas, puis tables du schéma après `schema.` ;
  - colonnes typées des tables visibles depuis la requête, `alias.` → colonnes de cette table, colonnes des sous-requêtes et CTE (`*` développé) ;
  - mots-clés dans l'ordre utile (FROM, WHERE, JOIN… d'abord), et en premier juste après un identifiant terminé (`from t |`, `where a = 1 |`) ;
  - fonctions utilisateur puis intégrées.
- **Contournements des limites du parseur** : il ne rattache pas les tables d'un UPDATE/DELETE à leur requête (visibilité décidée par position avec `splitSql`), rate certains alias (lus dans le texte), ne voit pas la liste de colonnes d'un `INSERT INTO t (` ni, en MySQL, les tables d'un UPDATE (extraites du texte par regex). `patches/dt-sql-parser+4.6.0.patch` corrige un plantage sur ces mêmes requêtes.
- **Diagnostics et formatage** : erreurs de syntaxe soulignées (worker), formatage par Ctrl+Alt+F ou le menu contextuel.

## Front-end

- **État** : tout l'état partagé vit dans `App.vue` (refs) et descend par props ; les composants remontent des événements (`run`, `context`, `open-table`, `reload`, `saved`…). Pas de store.
- **Persistance navigateur** (`localStorage`, préfixe `webgrip.`) : thème, connexion courante, base/schéma par connexion, texte de l'éditeur par connexion, hauteur de l'éditeur, nombre max de lignes.
- **Flux d'exécution** : `SqlEditor` émet `run({ sql, offset })` (sélection, requête sous le curseur ou tout le script) → `App.vue` appelle `/query` avec la base et le schéma courants → `ResultPanel` affiche un onglet par résultat et ouvre la première erreur s'il y en a une.
- **Arbre** (`DbTree.vue`) : nœuds chargés à l'ouverture, affichés à plat (calcul de l'indentation) pour rester léger ; un clic sur une base/un schéma change le contexte de l'éditeur, un double-clic sur une table ajoute et exécute `SELECT * … LIMIT n`.
- **Grille** (`ResultGrid.vue`) : une simple `<table>` HTML (en-tête et numéros de ligne collants), plutôt qu'un `v-data-table`, pour garder la main sur le rendu et la densité ; la limite de lignes côté serveur borne sa taille.

## Sécurité

- Les mots de passe sont stockés **en clair** dans `data/connections.json` (permissions `600`) et ne sont jamais renvoyés au navigateur.
- Aucune authentification : quiconque atteint le port de Vite (localhost ou tailnet) a un accès SQL complet aux connexions enregistrées.
