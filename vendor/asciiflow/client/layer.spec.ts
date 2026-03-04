import { Layer } from "#asciiflow/client/layer";
import { layerToText, textToLayer } from "#asciiflow/client/text_utils";
import { Vector } from "#asciiflow/client/vector";
import { expect } from "chai";

describe("layer", () => {

  it("converts v1 to v2", () => {
    const v1Encoded =
      '{"x":987,"y":286,"text":"    ┼       \\n┼┼┼┼┼┼┼┼┼┼┼┼\\n┼   ┼  Hi  ┼\\n┼   ┼      ┼\\n┼   ┼┼┼┼┼┼►┼\\n┼          ┼\\n┼┼┼┼┼┼┼┼┼┼┼┼"}';
    const decoded = Layer.deserialize(v1Encoded);
    const asText = layerToText(decoded);
    expect(asText).equals(`    │       
┌───┼──────┐
│   │  Hi  │
│   │      │
│   └─────►│
│          │
└──────────┘`);
  });

  it("textToLayer strips \\r from Windows line endings (#187)", () => {
    const layer = textToLayer("AB\r\nCD\r\n");
    expect(layer.get(new Vector(0, 0))).equals("A");
    expect(layer.get(new Vector(1, 0))).equals("B");
    expect(layer.get(new Vector(0, 1))).equals("C");
    expect(layer.get(new Vector(1, 1))).equals("D");
    // \r should not be stored as a character.
    expect(layer.get(new Vector(2, 0))).is.null;
  });

  it("textToLayer strips control characters (#187)", () => {
    const layer = textToLayer("A\x01B\x7FC");
    expect(layer.get(new Vector(0, 0))).equals("A");
    // \x01 (SOH) at position 1 should be skipped (treated like space).
    expect(layer.get(new Vector(1, 0))).is.null;
    expect(layer.get(new Vector(2, 0))).equals("B");
    // \x7F (DEL) at position 3 should be skipped.
    expect(layer.get(new Vector(3, 0))).is.null;
    expect(layer.get(new Vector(4, 0))).equals("C");
  });

  it("textToLayer roundtrips with layerToText", () => {
    const original = "┌───┐\n│ X │\n└───┘";
    const layer = textToLayer(original);
    const result = layerToText(layer);
    expect(result).equals(original);
  });

  it("serialize and deserialize v2", () => {
    const layer = new Layer();
    // This should stay as is and not be processed. by the legacy render layer.
    layer.set(new Vector(5, 10), "++");
    const encoded = Layer.serialize(layer);
    expect(JSON.parse(encoded).version).equals(2);
    const decoded = Layer.deserialize(encoded);
    const asText = layerToText(decoded);
    expect(asText).equals(`++`);
  });
});
