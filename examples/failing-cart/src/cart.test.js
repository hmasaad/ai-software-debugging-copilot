import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotal, getPrimaryItemId } from "./cart.js";

test("cartTotal defaults missing quantity to 1", () => {
  assert.equal(cartTotal([{ sku: "sku-1", price: 10 }]), 10);
});

test("getPrimaryItemId reads the item id", () => {
  assert.equal(getPrimaryItemId({ item: { id: "abc" } }), "abc");
});
