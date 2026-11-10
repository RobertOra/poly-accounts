# poly-accounts

**Open it:** https://robertora.github.io/poly-accounts/

A small home-screen web app: a read-only overview of several Polymarket accounts, one card each (portfolio, positions value, P&L chart, open positions, recent activity). Nothing is combined across accounts.

- Data comes from Polymarket's public Data API and the account's pUSD balance on Polygon. It never logs in and never trades.
- **No accounts are stored in this repository.** Add accounts in the app (Edit → username, profile link or wallet), or open a link like `…/poly-accounts/#user1,user2,0xWallet` (the part after `#` is never sent to a server). The list is kept only in the device's local storage; Edit → Copy link gives a link to your current list.
- Install on iPhone: open the link in Safari → Share → Add to Home Screen.
