# Contributing to mini-gateway

Thanks for helping improve mini-gateway — a stateless, minimal AI gateway (OpenAI- and Anthropic-compatible) with no database, no state, and nothing saved.

## How to contribute

1. Fork the repo and create a branch from `main`.
2. Make your change. Keep it small and focused — one fix or feature per pull request.
3. Test it locally: requires Node.js >= 20, then `npm start` (runs `node server.js`, listens on `PORT`, default 3000).
4. Open a pull request against `main` with a clear description of what changed and why.

## What we welcome

- Bug fixes (wrong routing, broken fallback, bad error handling)
- Small features that fit the stateless design (new compatible endpoints, better logging)
- Documentation fixes and examples
- Tests, if you can add them without changing the runtime behaviour

## What we do not accept

- Anything that adds a database, persistent state, or user tracking — statelessness is the point.
- Secrets, API keys, or credentials in code, config, or examples. Never commit a real key. Use `API_KEY`, `UPSTREAM`, and `GEMINI_KEY` as environment variables only.
- Large refactors without an issue discussing them first.

## Ground rules

- Be kind and specific in reviews and issues.
- Do not claim features, dependents, or performance numbers that are not real.
- If a change affects routing order (OmniRoute gateway → Gemini → Pollinations), say so explicitly in the PR description.

## Questions

Open an issue using the bug report or feature request template. Maintainer: Manas Jena (@jenam977-dot).
