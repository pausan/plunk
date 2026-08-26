import {useEffect, useState} from 'react';
import {useForm} from 'react-hook-form';
import {SendingProviderType} from '@plunk/db';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  IconSpinner,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Switch,
} from '@plunk/ui';
import {AlertTriangle, CheckCircle2, Mail, Server, XCircle} from 'lucide-react';
import {useSendingProvider, useTestSmtpConnection, useUpdateSendingProvider} from '../lib/hooks/useSendingConfig';

interface SendingProviderSettingsProps {
  projectId: string;
}

interface SmtpFormValues {
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
  fromOverride: string;
  maxSendRatePerSecond: string;
}

const DEFAULT_SMTP_VALUES: SmtpFormValues = {
  host: '',
  port: '587',
  secure: false,
  username: '',
  password: '',
  fromOverride: '',
  maxSendRatePerSecond: '5',
};

export function SendingProviderSettings({projectId}: SendingProviderSettingsProps) {
  const {settings, isLoading, mutate} = useSendingProvider(projectId);
  const {updateSendingProvider} = useUpdateSendingProvider();
  const {testConnection} = useTestSmtpConnection();

  const [provider, setProvider] = useState<SendingProviderType>(SendingProviderType.SES);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ok: boolean; error?: string} | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const form = useForm<SmtpFormValues>({defaultValues: DEFAULT_SMTP_VALUES});

  // Populate the form (and provider selection) once settings load — the password
  // field is intentionally never prefilled, it always starts blank/masked.
  useEffect(() => {
    if (!settings) return;

    setProvider(settings.sendingProvider);

    if (settings.smtpConfig) {
      form.reset({
        host: settings.smtpConfig.host,
        port: String(settings.smtpConfig.port),
        secure: settings.smtpConfig.secure,
        username: settings.smtpConfig.username,
        password: '',
        fromOverride: settings.smtpConfig.fromOverride ?? '',
        maxSendRatePerSecond: String(settings.smtpConfig.maxSendRatePerSecond),
      });
    }
  }, [settings, form]);

  const hasSavedSmtpConfig = !!settings?.smtpConfig;

  const clearMessages = () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setTestResult(null);
  };

  const handleTest = async () => {
    clearMessages();
    setIsTesting(true);
    try {
      const values = form.getValues();
      const result = await testConnection(projectId, {
        host: values.host,
        port: Number(values.port),
        secure: values.secure,
        username: values.username,
        password: values.password || undefined,
      });
      setTestResult(result);
    } catch (error) {
      setTestResult({ok: false, error: error instanceof Error ? error.message : 'Connection test failed'});
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async () => {
    clearMessages();

    if (provider === SendingProviderType.SMTP) {
      const values = form.getValues();
      if (!values.password && !hasSavedSmtpConfig) {
        setErrorMessage('A password is required the first time SMTP is configured for this project.');
        return;
      }
    }

    setIsSaving(true);
    try {
      if (provider === SendingProviderType.SMTP) {
        const values = form.getValues();
        await updateSendingProvider(projectId, {
          sendingProvider: SendingProviderType.SMTP,
          smtpConfig: {
            host: values.host,
            port: Number(values.port),
            secure: values.secure,
            username: values.username,
            password: values.password || undefined,
            fromOverride: values.fromOverride || null,
            maxSendRatePerSecond: Number(values.maxSendRatePerSecond),
          },
        });
      } else {
        await updateSendingProvider(projectId, {sendingProvider: SendingProviderType.SES});
      }

      await mutate();
      setSuccessMessage('Sending provider settings saved.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save sending provider settings');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || !settings) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <IconSpinner />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {settings.sendingProviderMisconfigured && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Plunk couldn&apos;t authenticate with this project&apos;s SMTP relay on the last send attempt. Emails will
            keep failing until the connection details below are corrected and saved.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Sending Provider
          </CardTitle>
          <CardDescription>Choose how emails from this project are delivered.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <RadioGroup
            value={provider}
            onValueChange={value => {
              setProvider(value as SendingProviderType);
              clearMessages();
            }}
            className="space-y-3"
          >
            <label
              htmlFor="provider-ses"
              className="flex items-start gap-3 rounded-lg border border-neutral-200 p-4 cursor-pointer has-[:checked]:border-neutral-900 has-[:checked]:bg-neutral-50"
            >
              <RadioGroupItem value={SendingProviderType.SES} id="provider-ses" className="mt-1" />
              <div>
                <p className="text-sm font-medium text-neutral-900">AWS SES (default)</p>
                <p className="text-sm text-neutral-500">
                  Send through Plunk&apos;s shared AWS account. Includes open/click tracking, bounce and complaint
                  handling, and domain verification.
                </p>
              </div>
            </label>

            <label
              htmlFor="provider-smtp"
              className="flex items-start gap-3 rounded-lg border border-neutral-200 p-4 cursor-pointer has-[:checked]:border-neutral-900 has-[:checked]:bg-neutral-50"
            >
              <RadioGroupItem value={SendingProviderType.SMTP} id="provider-smtp" className="mt-1" />
              <div>
                <p className="text-sm font-medium text-neutral-900 flex items-center gap-2">
                  Custom SMTP
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    Beta
                  </Badge>
                </p>
                <p className="text-sm text-neutral-500">
                  Send through your own SMTP relay. Opens/clicks are tracked natively by Plunk; bounces are only
                  detected synchronously (an immediate rejection), and domain verification doesn&apos;t apply — your
                  relay must already have SPF/DKIM configured.
                </p>
              </div>
            </label>
          </RadioGroup>

          {provider === SendingProviderType.SMTP && (
            <div className="space-y-4 rounded-lg border border-neutral-200 p-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-2 space-y-2">
                  <Label htmlFor="smtp-host">Host</Label>
                  <Input id="smtp-host" placeholder="smtp.example.com" {...form.register('host')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="smtp-port">Port</Label>
                  <Input id="smtp-port" type="number" placeholder="587" {...form.register('port')} />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-neutral-200 p-3">
                <div>
                  <Label htmlFor="smtp-secure">Use TLS/SSL</Label>
                  <p className="text-xs text-neutral-500">
                    On for implicit TLS (usually port 465), off for STARTTLS (usually port 587).
                  </p>
                </div>
                <Switch
                  id="smtp-secure"
                  checked={form.watch('secure')}
                  onCheckedChange={checked => form.setValue('secure', checked)}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="smtp-username">Username</Label>
                  <Input id="smtp-username" autoComplete="username" {...form.register('username')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="smtp-password">Password</Label>
                  <Input
                    id="smtp-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder={hasSavedSmtpConfig ? '••••••••  (leave blank to keep current)' : ''}
                    {...form.register('password')}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="smtp-from-override">From address override (optional)</Label>
                  <Input id="smtp-from-override" placeholder="hello@example.com" {...form.register('fromOverride')} />
                  <p className="text-xs text-neutral-500">Leave blank to use each email&apos;s own From address.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="smtp-rate-limit">Max sends per second</Label>
                  <Input
                    id="smtp-rate-limit"
                    type="number"
                    min={1}
                    {...form.register('maxSendRatePerSecond')}
                  />
                  <p className="text-xs text-neutral-500">Match your relay&apos;s own rate limit, if it has one.</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button type="button" variant="outline" onClick={handleTest} disabled={isTesting}>
                  {isTesting ? <IconSpinner size="sm" /> : 'Test Connection'}
                </Button>

                {testResult && (
                  <span
                    className={`text-sm flex items-center gap-1.5 ${testResult.ok ? 'text-green-700' : 'text-red-700'}`}
                  >
                    {testResult.ok ? (
                      <>
                        <CheckCircle2 className="h-4 w-4" /> Connection succeeded
                      </>
                    ) : (
                      <>
                        <XCircle className="h-4 w-4" /> {testResult.error ?? 'Connection failed'}
                      </>
                    )}
                  </span>
                )}
              </div>

              {settings.smtpConfig?.lastTestedAt && (
                <p className="text-xs text-neutral-400 flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5" />
                  Last tested {new Date(settings.smtpConfig.lastTestedAt).toLocaleString()} —{' '}
                  {settings.smtpConfig.lastTestOk ? 'succeeded' : 'failed'}
                </p>
              )}
            </div>
          )}

          {errorMessage && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{errorMessage}</div>
          )}
          {successMessage && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
              {successMessage}
            </div>
          )}

          <div className="flex justify-end">
            <Button type="button" onClick={handleSave} disabled={isSaving}>
              {isSaving ? <IconSpinner size="sm" /> : 'Save'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
