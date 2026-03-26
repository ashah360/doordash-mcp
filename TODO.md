# TODO

Tracked improvements and missing features.

## Metadata gaps

- [x] Surface store address and location in menu/group order responses
- [x] Surface item image URLs
- [x] Surface dietary tags (vegetarian, vegan, etc.)
- [x] Surface caloric info
- [x] Surface item quantity limits
- [ ] Surface item discount/promotional pricing (`discountPricesList`)
- [ ] Surface store cover image URL
- [ ] Surface store open/closed status and hours of operation
- [ ] Surface delivery fee estimates in search results

## Discoverability

- [ ] Add a "nearby stores" feed (homepage/storeFeed query) — browse restaurants without a search query
- [ ] Add search filters (cuisine, price range, rating, delivery time)
- [ ] Add in-restaurant item search for regular stores (not just convenience stores)
- [ ] Investigate menu pagination — large menus may be truncated without cursor support

## Order tracking

- [ ] Rich order status: dasher name, live ETA, prep status, pickup status
- [ ] Delivery route info (number of stops, current location)
- [ ] Order status transitions (preparing → dasher waiting → picked up → on the way → delivered)

## Convenience stores

- [ ] Browse convenience store categories (currently search-only)
- [ ] Convenience store item pagination

## Other

- [ ] Scheduled orders (time slot selection, not just ASAP)
- [ ] Re-order from order history
- [ ] Store hours of operation (need to find the right query)
