# HandInHand Server

Express.js + MongoDB API for the HandInHand community events platform. Protected routes verify the JWT issued by Better Auth on the client app (via its JWKS endpoint).

## Routes

| Method | Route | Access |
| --- | --- | --- |
| GET | `/events` | Public, upcoming events only |
| GET | `/recent-events` | Public, 6 soonest upcoming events (`.limit(6)`) |
| GET | `/event/:id` | Public |
| POST | `/add-event` | JWT |
| PATCH / DELETE | `/event/:id` | JWT, owner only |
| GET | `/manage-events/:email` | JWT, own email only |
| POST | `/join-event` | JWT |
| GET | `/joined-events/:email` | JWT, own email only |

## Run

```bash
npm install
cp .env.example .env   # fill in the values
npm run dev
```
