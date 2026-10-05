<!-- Meadow — getting USDC on Base. Markdown copy of https://meadowprotocol.com/get-usdc, generated from the page. -->

> How to put money in your Meadow wallet: what USDC and Base are, what to choose at an exchange, and what has worked in which countries.

# Getting USDC on Base

Making a wallet in the Meadow app takes a minute. Putting money in it is the part that depends on where you live. This page says exactly what your wallet needs, and what has worked in which countries.

> **What your wallet needs.** At an exchange or in another wallet, choose exactly this:
>
> **Asset**: USDC
>
> **Network**: Base
>
> **Address**: your wallet's address, from *Top off* in the Meadow app (copy it, or scan its QR code)

## What are USDC and Base?

- **USDC** is a digital dollar: one USDC is worth about one US dollar. Meadow's calls are paid in it, half a cent each at the time of writing (the app shows the current price).
- **Base** is the network USDC travels on for Meadow, like choosing which bank a transfer goes through. The same USDC exists on other networks too, so when you send it, you must choose Base.
- **There is nothing to connect to.** The app connects to Base by itself. "Base" matters only when you send money to your wallet: it is the network you pick.
- **Your wallet** is an address, a long code starting with `0x`. It is like an account number that only the app, and your recovery phrase, can spend from. You do not need any ETH.

## Send a small amount first

Send about $1 first. While *Top off* is open, the app checks the balance every 15 seconds and tells you when it arrives. Then send the rest.

- Choose **USDC**, then **Base** as the network. Some exchanges call it "Base Mainnet" or show the Base logo.
- Do not choose **USDbC**: it is an older copy of USDC on Base, and the app does not use it.
- No memo or tag is needed.

## If you choose the wrong network

The money is not lost if the network you chose uses the same kind of address as Base: Ethereum, Arbitrum, Optimism, Polygon, or BNB Smart Chain (sometimes shown as "BEP20"). Your recovery phrase controls the same address there, so the money is still yours. But the app can only use USDC on Base. It looks on those networks and tells you if it finds your money there. From version 0.1.5, **Move to Base** (on the wallet's card, and in *Top off*) moves USDC on Ethereum, Arbitrum, or Polygon to Base for you: you sign once, the bridge's fee comes out of the USDC, and the app shows the fee and what arrives before you agree. It also swaps USDbC on Base for USDC. Older bridged USDC, and USDC on BNB Smart Chain, cannot be moved by the app yet.

Networks with a different kind of address, such as Solana or Tron, will not accept your wallet's address, so an exchange should refuse to send there.

## Where to get it

Look for an exchange or app **available in your country** that lets you **withdraw USDC on the Base network**. On 1 October 2026, Coinbase, Binance, OKX, Kraken, Bybit, and Crypto.com all listed "USDC (Base)" as a network for sending USDC. Which ones you can use, how you pay, and what they charge depend on your country and change over time. Check their own pages.

Or **ask someone who already has USDC on Base** to send it to your wallet's address. They can scan the QR code in *Top off*.

The app has no "buy" button. Every service that sells crypto inside an app needs that app's makers to run a server in the middle of the purchase. Meadow runs nothing between you and your money.

## By country

Each entry says who confirmed it, and when. An entry more than six months old is marked as not checked recently. Tell us what works where you live (see the end of this page).

### Brazil

- **What works:** Pix → Coinbase → buy USDC (Coinbase sells USDC for reais, and takes Pix deposits) → send it, choosing the **Base** network, to your wallet's address.
- **Watch for:** the network. "Send USDC" alone is not enough: choose Base.

Confirmed by a tester (the route), and by Coinbase's own pages (Pix, USDC for reais, Brazil listed for buying USDC), 1 October 2026.

### Chile

- **Coinbase:** Coinbase's own help page lists Chile among the countries where you can buy USDC with money. But a tester in Chile could not buy on their account. If Coinbase will not sell to you, try another exchange below.
- **Binance:** available from Chile, with card or peer-to-peer (P2P) purchases. Binance lists USDC on Base: check that its withdrawal screen offers Base for USDC before you buy.
- **Buda.com** sells USDC for pesos, but as far as its help pages say, it sends USDC only on Ethereum. USDC sent from Buda would arrive on Ethereum. It would still be yours, and the app's **Move to Base** can bring it over, but Ethereum's network fee takes a few dollars of it (about $2.83 on 1 October 2026), so it suits larger amounts.

A tester, Coinbase's help page (USDC regions), and Buda's help pages, 1 October 2026. The Binance withdrawal network is not confirmed yet.

## About this page

Nothing here is a recommendation or financial advice. Meadow takes no fees or referral payments from any of these services, and these links carry none. Prices, fees, and rules change. What a service will do for you depends on your country and your account.

Tell us what works, or stopped working, where you live: open an issue on [the project's GitHub](https://github.com/TheFeloniousMonk/meadow-node/issues) with your country, the service, and the steps. We add it after checking the service's own help pages.
