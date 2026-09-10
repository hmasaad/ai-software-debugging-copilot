/**
 * Intentionally buggy cart — used to demo Debugging Copilot.
 *
 * lineTotal() multiplies by `item.qty` with no default, so a missing
 * quantity becomes NaN and corrupts the whole cart total.
 */
export function lineTotal(item) {
  return item.price * item.qty;
}

export function cartTotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

export function getPrimaryItemId(order) {
  return order.item.id;
}
