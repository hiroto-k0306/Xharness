import markUrl from "../../../brand/mark.svg";

/** brand/mark.svg(背景なしのマーク)。各社ロゴは使わない(§16.10)。 */
export function Logo({ size = 14 }: { size?: number }) {
  return (
    <img
      src={markUrl}
      alt=""
      width={size}
      height={size}
      style={{ imageRendering: "pixelated", flex: "none" }}
      draggable={false}
    />
  );
}
