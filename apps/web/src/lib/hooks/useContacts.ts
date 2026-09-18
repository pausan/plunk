import type {Contact} from '@plunk/db';
import type {ContactField, ContactFieldList, CursorPaginatedResponse, PaginatedResponse} from '@plunk/types';
import {useCallback, useState} from 'react';
import useSWR from 'swr';

import {network} from '../network';

interface UseContactsOptions {
  limit?: number;
  search?: string;
}

/** Stable identity so consumers' effect dependencies don't churn before the fetch lands. */
const NO_FIELDS: ContactField[] = [];

export type {ContactField};

/** The `GET /contacts/fields` payload. */
interface ContactFieldsResponse extends ContactFieldList {
  count: number;
}

/**
 * Hook to fetch contacts with optional search
 */
export function useContacts(options: UseContactsOptions = {}) {
  const {limit = 50, search} = options;

  const params = new URLSearchParams();
  params.set('limit', limit.toString());
  if (search) {
    params.set('search', search);
  }

  const {data, error, mutate, isLoading} = useSWR<CursorPaginatedResponse<Contact>>(`/contacts?${params.toString()}`, {
    revalidateOnFocus: false,
    dedupingInterval: 10000, // Prevent duplicate requests within 10 seconds
  });

  return {
    contacts: data?.data || [],
    total: data?.total || 0,
    error,
    isLoading,
    mutate,
  };
}

/**
 * Hook to fetch the contacts belonging to a specific segment.
 *
 * Backed by `GET /segments/:id/contacts`, which resolves both STATIC
 * (via SegmentMembership) and DYNAMIC (via condition) segments. Used by the
 * email editor to scope the "Preview as" dropdown to the campaign's selected
 * audience instead of every contact in the project.
 *
 * When `segmentId` is undefined/empty the SWR key is null, so no request is
 * made and an empty list is returned (callers fall back to all contacts).
 */
export function useSegmentContacts(segmentId?: string, pageSize = 50) {
  const {data, error, mutate, isLoading} = useSWR<PaginatedResponse<Contact>>(
    segmentId ? `/segments/${segmentId}/contacts?page=1&pageSize=${pageSize}` : null,
    {
      revalidateOnFocus: false,
      dedupingInterval: 10000, // Prevent duplicate requests within 10 seconds
    },
  );

  return {
    contacts: data?.data ?? [],
    total: data?.total ?? 0,
    error,
    isLoading,
    mutate,
  };
}

/**
 * Hook to fetch available contact fields for variable usage.
 *
 * The server computes this list by scanning the project's contacts and then caches it
 * for hours, so a field written for the first time a minute ago may not be in it yet.
 * `computedAt` says how old the list is and `refresh` forces a rescan — see
 * ContactService.getAvailableFields.
 */
export function useContactFields() {
  const {data, error, mutate, isLoading} = useSWR<ContactFieldsResponse>('/contacts/fields', {
    revalidateOnFocus: false,
    // Cache fields for longer since they don't change often
    dedupingInterval: 60000, // 1 minute
  });

  const [isRefreshing, setIsRefreshing] = useState(false);

  /**
   * Ask the server to rescan for custom fields and adopt the result.
   *
   * Writes the response straight into the SWR cache with `revalidate: false`: the POST
   * already returns the newly computed list, so revalidating would immediately re-fetch
   * what we are holding.
   */
  const refresh = useCallback(async () => {
    setIsRefreshing(true);

    try {
      const refreshed = await network.fetch<ContactFieldsResponse>('POST', '/contacts/fields/refresh');
      await mutate(refreshed, {revalidate: false});
      return refreshed;
    } finally {
      setIsRefreshing(false);
    }
  }, [mutate]);

  const fieldDetails = data?.fields ?? NO_FIELDS;
  const fieldNames = fieldDetails.map(f => f.field);

  return {
    fields: fieldNames,
    // The endpoint also returns an inferred type and what share of contacts actually
    // carry each field. The editor's suggestion menus use both: a field only 4% of
    // contacts have is the difference between a working template and a silent blank.
    fieldDetails,
    /** ISO timestamp of the scan behind this list, or undefined before it loads. */
    computedAt: data?.computedAt,
    error,
    isLoading,
    isRefreshing,
    refresh,
    mutate,
  };
}
