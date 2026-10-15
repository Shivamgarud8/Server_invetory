import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { CredentialType, Environment, Tag } from "./types";

/** Load data from an async function; re-runs when deps change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    fn()
      .then((d) => id === seq.current && (setData(d), setError(null)))
      .catch((e) => id === seq.current && setError(e.message))
      .finally(() => id === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload, setData };
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface Lookups {
  environments: Environment[];
  tags: Tag[];
  types: CredentialType[];
}

let cache: Promise<Lookups> | null = null;

export function invalidateLookups() {
  cache = null;
}

export function useLookups(): Lookups {
  const [l, setL] = useState<Lookups>({ environments: [], tags: [], types: [] });
  useEffect(() => {
    if (!cache) {
      cache = Promise.all([
        api.get<Environment[]>("/environments"),
        api.get<Tag[]>("/tags"),
        api.get<CredentialType[]>("/credential-types"),
      ]).then(([environments, tags, types]) => ({ environments, tags, types }));
      cache.catch(() => (cache = null));
    }
    cache.then(setL).catch(() => undefined);
  }, []);
  return l;
}
