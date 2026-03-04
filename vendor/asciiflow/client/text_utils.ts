import { Box } from "#asciiflow/client/common";
import { ILayerView, Layer } from "#asciiflow/client/layer";
import { Vector } from "#asciiflow/client/vector";

export function layerToText(layer: ILayerView, box?: Box) {
  if (layer.keys().length === 0) {
    return "";
  }
  if (!box) {
    // Find the first/last cells in the diagram so we don't output everything.
    const start = new Vector(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const end = new Vector(Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER);

    layer.keys().forEach((position) => {
      start.x = Math.min(start.x, position.x);
      start.y = Math.min(start.y, position.y);
      end.x = Math.max(end.x, position.x);
      end.y = Math.max(end.y, position.y);
    });
    box = new Box(start, end);
  }

  const lineArrays = [
    ...new Array(box.bottomRight().y - box.topLeft().y + 1),
  ].map((x) =>
    [...new Array(box.bottomRight().x - box.topLeft().x + 1)].fill(" ")
  ) as string[][];

  layer
    .entries()
    .filter(([key, value]) => box.contains(key) && !!value)
    .forEach(([key, value]) => {
      if (value.charCodeAt(0) < 32 || value.charCodeAt(0) == 127) {
        // Every ascii value below 32 is control, and 127 is DEL.
        // Allow everything else and any unicode characters if they happen to be in the string.
        value = " ";
      }
      lineArrays[key.y - box.topLeft().y][key.x - box.topLeft().x] = value;
    });
  return lineArrays
    .map((lineValues) => lineValues.reduce((acc, curr) => acc + curr, ""))
    .join("\n");
}

/**
 * Loads the given text into the diagram starting at the given offset (centered).
 */
export function textToLayer(value: string, offset?: Vector) {
  if (!offset) {
    offset = new Vector(0, 0);
  }
  const layer = new Layer();
  // Normalise line endings: \r\n (Windows) and \r (old Mac) → \n.
  const lines = value.replace(/\r\n?/g, "\n").split("\n");

  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    for (let i = 0; i < line.length; i++) {
      const char = line.charAt(i);
      // Skip spaces and control characters (ASCII 0–31, 127 DEL).
      if (char !== " " && char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) {
        layer.set(new Vector(i, j).add(offset), char);
      }
    }
  }
  return layer;
}
