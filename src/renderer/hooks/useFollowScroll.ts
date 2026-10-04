import { useLayoutEffect, useRef } from "react";

/** 各ペインだけを追従する。遡ったら停止し、最下部へ戻ったら再開する。 */
export function useFollowScroll(update: unknown, scope?: string) {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const follow = () => {
    const pane = ref.current;
    if (pane && following.current)
      pane.scrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight);
  };
  useLayoutEffect(() => {
    following.current = true;
    follow();
  }, [scope]);
  useLayoutEffect(() => {
    follow();
  }, [update]);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane) return;
    const scroll = () => {
      following.current =
        pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 2;
    };
    // wheel の直後、scroll イベントより先に出力が届いても遡りを妨げない。
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) following.current = false;
    };
    pane.addEventListener("scroll", scroll, { passive: true });
    pane.addEventListener("wheel", wheel, { passive: true });
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(follow);
    resize?.observe(pane);
    // 画像読み込みや details 開閉など、イベント以外の高さ変化も追従する。
    const observeChildren = () => {
      resize?.disconnect();
      resize?.observe(pane);
      for (const child of pane.children) resize?.observe(child);
      follow();
    };
    const mutation = new MutationObserver(observeChildren);
    mutation.observe(pane, { childList: true });
    observeChildren();
    return () => {
      pane.removeEventListener("scroll", scroll);
      pane.removeEventListener("wheel", wheel);
      resize?.disconnect();
      mutation.disconnect();
    };
  }, [update, scope]);
  return ref;
}
