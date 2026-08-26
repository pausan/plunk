import {SendingProviderSchemas} from '@plunk/shared';
import type {
  SendingProviderSettings,
  TestSmtpConnectionInput,
  TestSmtpConnectionResult,
  UpdateSendingProviderInput,
} from '@plunk/types';
import useSWR from 'swr';

import {network} from '../network';

/**
 * Hook to fetch a project's sending provider settings (AWS SES vs. a custom SMTP relay).
 */
export function useSendingProvider(projectId: string | undefined) {
  const {data, error, mutate, isLoading} = useSWR<SendingProviderSettings>(
    projectId ? `/sending-provider/${projectId}` : null,
  );

  return {
    settings: data,
    error,
    isLoading,
    mutate,
  };
}

/**
 * Hook to update a project's sending provider (and, when switching to SMTP, its
 * connection config). Omitting smtpConfig.password on an update keeps the
 * existing saved password.
 */
export function useUpdateSendingProvider() {
  const updateSendingProvider = async (projectId: string, input: UpdateSendingProviderInput) => {
    return network.fetch<SendingProviderSettings, typeof SendingProviderSchemas.update>(
      'PATCH',
      `/sending-provider/${projectId}`,
      input,
    );
  };

  return {updateSendingProvider};
}

/**
 * Hook to check connectivity/auth against an SMTP relay — no email is sent.
 */
export function useTestSmtpConnection() {
  const testConnection = async (projectId: string, input: TestSmtpConnectionInput) => {
    return network.fetch<TestSmtpConnectionResult, typeof SendingProviderSchemas.test>(
      'POST',
      `/sending-provider/${projectId}/test`,
      input,
    );
  };

  return {testConnection};
}
