# poly-accounts

**Open it:** https://robertora.github.io/poly-accounts/

A small home-screen web app: a read-only overview of several Polymarket accounts, one card each (portfolio, positions value, P&L chart, open positions, recent activity). Nothing is combined across accounts.

- Data comes from Polymarket's public Data API and the account's pUSD balance on Polygon. It never logs in and never trades.
- **No accounts are stored in this repository.** The list of wallets arrives in the link's `#fragment` (which browsers never send to a server) and is kept only in the device's local storage.
- Install on iPhone: open the link in Safari → Share → Add to Home Screen.
