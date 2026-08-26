import {beforeEach, describe, expect, it, vi} from 'vitest';

const sendMailMock = vi.fn();
const verifyMock = vi.fn();
const closeMock = vi.fn();

// Hoisted above the imports below by vitest, so SmtpProvider picks up this
// mocked transport factory rather than opening a real SMTP connection.
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: sendMailMock,
      verify: verifyMock,
      close: closeMock,
    })),
  },
}));

import {PermanentSendError, ProviderAuthError, ThrottledSendError, TransientSendError} from '../EmailProvider';
import {SmtpProvider} from '../SmtpProvider';

const BASE_CONFIG = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  username: 'user',
  password: 'pass',
  maxSendRatePerSecond: 5,
};

const MESSAGE = {
  emailId: 'email-1',
  from: {name: 'Plunk', email: 'hello@example.com'},
  to: ['recipient@example.com'],
  content: {subject: 'Hi', html: '<p>Hi</p>'},
};

// This test suite is the load-bearing correctness check for the whole
// permanent/transient/throttled/auth error taxonomy that email-processor.ts's
// retry-vs-bounce-vs-throttle branching depends on — see EmailProvider.ts.
describe('SmtpProvider error classification', () => {
  beforeEach(() => {
    sendMailMock.mockReset();
    verifyMock.mockReset();
    closeMock.mockReset();
  });

  it('classifies a 5xx SMTP rejection as PermanentSendError (a bounce, not a retry)', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('Recipient rejected'), {responseCode: 550}));
    const provider = new SmtpProvider(BASE_CONFIG);
    await expect(provider.send(MESSAGE)).rejects.toBeInstanceOf(PermanentSendError);
  });

  it('classifies a 4xx SMTP rejection as TransientSendError, never as a bounce', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('Greylisted'), {responseCode: 450}));
    const provider = new SmtpProvider(BASE_CONFIG);
    await expect(provider.send(MESSAGE)).rejects.toBeInstanceOf(TransientSendError);
  });

  it('classifies a 421 (too many connections) as ThrottledSendError', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('Too many connections'), {responseCode: 421}));
    const provider = new SmtpProvider(BASE_CONFIG);
    await expect(provider.send(MESSAGE)).rejects.toBeInstanceOf(ThrottledSendError);
  });

  it('classifies an EAUTH failure as ProviderAuthError (operator-config problem)', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('Invalid login'), {code: 'EAUTH'}));
    const provider = new SmtpProvider(BASE_CONFIG);
    await expect(provider.send(MESSAGE)).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('classifies a connection timeout as TransientSendError (safe to retry)', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('Connection timed out'), {code: 'ETIMEDOUT'}));
    const provider = new SmtpProvider(BASE_CONFIG);
    await expect(provider.send(MESSAGE)).rejects.toBeInstanceOf(TransientSendError);
  });

  it('falls back to a rejected-recipient response code nested under rejectedErrors', async () => {
    sendMailMock.mockRejectedValue(
      Object.assign(new Error('Some recipients were rejected'), {rejectedErrors: [{responseCode: 550}]}),
    );
    const provider = new SmtpProvider(BASE_CONFIG);
    await expect(provider.send(MESSAGE)).rejects.toBeInstanceOf(PermanentSendError);
  });

  it('resolves with the provider messageId on success', async () => {
    sendMailMock.mockResolvedValue({messageId: '<abc@smtp.example.com>'});
    const provider = new SmtpProvider(BASE_CONFIG);
    await expect(provider.send(MESSAGE)).resolves.toEqual({messageId: '<abc@smtp.example.com>'});
  });

  it('closes the transport after every send, on both success and failure', async () => {
    sendMailMock.mockRejectedValueOnce(Object.assign(new Error('boom'), {responseCode: 550}));
    const provider = new SmtpProvider(BASE_CONFIG);
    await provider.send(MESSAGE).catch(() => undefined);
    expect(closeMock).toHaveBeenCalledTimes(1);

    sendMailMock.mockResolvedValueOnce({messageId: '<abc@smtp.example.com>'});
    await provider.send(MESSAGE);
    expect(closeMock).toHaveBeenCalledTimes(2);
  });

  it('getThroughput() returns the static per-project configured rate (no dynamic quota for SMTP)', async () => {
    const provider = new SmtpProvider({...BASE_CONFIG, maxSendRatePerSecond: 42});
    await expect(provider.getThroughput()).resolves.toEqual({maxPerSecond: 42});
  });

  it('verifyConnection() classifies transport.verify() failures the same way as send()', async () => {
    verifyMock.mockRejectedValue(Object.assign(new Error('Invalid login'), {code: 'EAUTH'}));
    const provider = new SmtpProvider(BASE_CONFIG);
    await expect(provider.verifyConnection()).rejects.toBeInstanceOf(ProviderAuthError);
  });
});
