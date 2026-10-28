"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * A ref that always holds the latest value — for animation loops and long-lived callbacks that must
 * see current props without restarting. Updated after render, as React requires.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
