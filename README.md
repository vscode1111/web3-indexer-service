# web3-indexer-service

EVM deposit/withdrawal on-chain indexer at **100 TPS**. Monitors contract events in
real time and exposes a REST API to the signing service and admin frontend.

## Overview

Event-driven indexer that tracks deposit and withdrawal transactions for the SQR
token contracts. Listens to on-chain events via ethers.js, writes to PostgreSQL via
TypeORM, and exposes the indexed state through a Moleculer REST API consumed by the
signing service (replay-prevention lookups) and a React Admin dashboard.

Running at 100 TPS during the MagicSquare TGE claim wave.

## Architecture

```
Ethereum / EVM node (RPC)
  -> ethers.js event listener (per contract, per event type)
  -> TypeORM entities (deposit, withdrawal, wallet balance)
  -> PostgreSQL
  -> Moleculer REST API
      -> signing service  (nonce / replay lookups)
      -> React Admin frontend (admin dashboard)
```

NATS transport between Moleculer services. Helm/K8s deployment.

## Key decisions

**Event listener per contract, not block polling:** subscribing to specific contract
events via `contract.on(eventName, handler)` reduces RPC load versus polling every
block. On high-volume contracts, block polling at 100 TPS would saturate a public RPC.

**TypeORM over raw SQL:** the admin frontend needs flexible queries (filter by wallet,
date range, status). TypeORM's query builder keeps those queries safe without writing
raw SQL strings that would require manual escaping.

## Setup & run

```bash
npm install
npm run build
npm run dev        # development
npm run start      # production
```

Copy `.env.example` to `.env` and configure PostgreSQL, RPC URL, contract addresses,
and NATS URL.

## Test coverage

```bash
npm test
```

## License

Proprietary.
