# Lab 18 — Starter Sample

This folder is the starter scaffold for [Lab 18](../index.md). It mirrors the structure the lab walks you through so you can either follow along step-by-step in the lab, or jump straight in.

## Quick start

```bash
cd labs/32-embed-agent-web-sdk/sample
npm install
# Edit src/config.ts with your tenant, client, environment, and agent IDs
npm run dev
```

Open the printed URL (usually `http://localhost:5173`), click **Sign in**, and start chatting.

## What's in this folder

| Path | Purpose |
|---|---|
| `package.json` | Vite + TypeScript + SDK + MSAL dependencies |
| `index.html` | Page shell |
| `src/config.ts` | Auth, agent, and branding configuration — **edit this first** |
| `src/auth.ts` | MSAL helpers (sign in, silent token acquisition) |
| `src/chatClient.ts` | Copilot Studio Client SDK wrapper |
| `src/ui.ts` | Activity renderer (text, suggested actions, adaptive card fallback) |
| `src/main.ts` | Wires the UI to the SDK |
| `src/styles.css` | Branded styling — driven by CSS variables from `config.ts` |

## Before you run

You need five values, captured by following Use Cases 1 and 2 of the lab:

1. **Tenant ID** (Entra)
2. **Client ID** (Entra app registration)
3. **Environment ID** (Power Platform)
4. **Agent schema name** (Copilot Studio agent setting)
5. **Cloud** (typically `Prod`)

Drop them into `src/config.ts`.

## Branding

Open `src/config.ts` and edit the `branding` object — colors, product name, tagline, avatar, welcome message. The UI rebuilds on save.

## Production checklist

The lab's *Going further* section covers what to harden before deploying:
adaptive card rendering, conversation persistence, accessibility, CSP,
production redirect URIs, and more.
