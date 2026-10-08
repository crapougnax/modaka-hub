import React, { useState, useEffect } from 'react';
import {
  Modal,
  Tabs,
  TextInput,
  PasswordInput,
  Select,
  Button,
  Group,
  Stack,
  Text,
  Badge,
  Paper,
  Divider,
  Alert,
  SimpleGrid,
  Box,
  ThemeIcon
} from '@mantine/core';
import {
  IconSettings,
  IconSparkles,
  IconDatabase,
  IconGitBranch,
  IconShieldCheck,
  IconDeviceFloppy,
  IconCheck,
  IconAlertCircle,
  IconServer
} from '@tabler/icons-react';

interface AdminSettingsModalProps {
  opened: boolean;
  onClose: () => void;
}

export function AdminSettingsModal({ opened, onClose }: AdminSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<string | null>('llm');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Form states
  const [llmProvider, setLlmProvider] = useState('gemini');
  const [llmModel, setLlmModel] = useState('gemini-2.5-flash');
  const [geminiApiKey, setGeminiApiKey] = useState('');

  const [storageType, setStorageType] = useState('local');
  const [docStoragePath, setDocStoragePath] = useState('');
  const [s3Bucket, setS3Bucket] = useState('world-agronomy');
  const [s3Region, setS3Region] = useState('us-east-1');
  const [s3Endpoint, setS3Endpoint] = useState('');
  const [s3AccessKey, setS3AccessKey] = useState('');
  const [s3SecretKey, setS3SecretKey] = useState('');

  const [gitLocalPath, setGitLocalPath] = useState('');
  const [gitRepoOwner, setGitRepoOwner] = useState('Quatrain');
  const [gitRepoName, setGitRepoName] = useState('knowledge');
  const [gitBranch, setGitBranch] = useState('develop');
  const [gitMode, setGitMode] = useState('local');

  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [allowedDomain, setAllowedDomain] = useState('*');

  const loadConfig = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/config');
      if (res.ok) {
        const data = await res.json();
        if (data.llm) {
          setLlmProvider(data.llm.provider || 'gemini');
          setLlmModel(data.llm.model || 'gemini-2.5-flash');
          setGeminiApiKey(data.llm.apiKey || '');
        }
        if (data.storage) {
          setStorageType(data.storage.type || 'local');
          setDocStoragePath(data.storage.documentStoragePath || '');
          setS3Bucket(data.storage.s3Bucket || 'documents');
          setS3Region(data.storage.s3Region || 'us-east-1');
          setS3Endpoint(data.storage.s3Endpoint || '');
          setS3AccessKey(data.storage.s3AccessKey || '');
          setS3SecretKey(data.storage.s3SecretKey || '');
        }
        if (data.git) {
          setGitLocalPath(data.git.localPath || '');
          setGitRepoOwner(data.git.repoOwner || 'Quatrain');
          setGitRepoName(data.git.repoName || 'knowledge');
          setGitBranch(data.git.branch || 'develop');
          setGitMode(data.git.mode || 'local');
        }
        if (data.auth) {
          setSupabaseUrl(data.auth.supabaseUrl || '');
          setAllowedDomain(data.auth.allowedDomain || '*');
        }
      } else {
        setError('Impossible de charger la configuration (droits admin requis).');
      }
    } catch (e: any) {
      setError(`Erreur de connexion : ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (opened) {
      loadConfig();
      setSuccess(false);
    }
  }, [opened]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const payload = {
        llm: {
          provider: llmProvider,
          model: llmModel,
          apiKey: geminiApiKey
        },
        storage: {
          type: storageType,
          documentStoragePath: docStoragePath,
          s3Bucket,
          s3Region,
          s3Endpoint,
          s3AccessKey,
          s3SecretKey
        },
        git: {
          localPath: gitLocalPath,
          repoOwner: gitRepoOwner,
          repoName: gitRepoName,
          branch: gitBranch,
          mode: gitMode
        }
      };

      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      } else {
        const err = await res.json();
        setError(err.message || "Échec de l'enregistrement");
      }
    } catch (e: any) {
      setError(`Erreur : ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <ThemeIcon color="yellow" variant="light" size="md">
            <IconSettings size={18} />
          </ThemeIcon>
          <Text fw={700} size="md">
            Paramètres Système Modaka-Hub
          </Text>
          <Badge color="yellow" size="xs" variant="outline">
            Admin Only
          </Badge>
        </Group>
      }
      size="xl"
      centered
      styles={{
        header: { backgroundColor: '#161b22', borderBottom: '1px solid #30363d' },
        body: { backgroundColor: '#0d1117', padding: '1.5rem' },
        content: { border: '1px solid #30363d', borderRadius: '12px' }
      }}
    >
      {error && (
        <Alert icon={<IconAlertCircle size={16} />} title="Erreur" color="red" mb="md">
          {error}
        </Alert>
      )}

      {success && (
        <Alert icon={<IconCheck size={16} />} title="Succès" color="teal" mb="md">
          Paramètres enregistrés et appliqués avec succès.
        </Alert>
      )}

      <Tabs value={activeTab} onChange={setActiveTab} color="yellow">
        <Tabs.List mb="md">
          <Tabs.Tab value="llm" leftSection={<IconSparkles size={16} />}>
            Modèles LLM & IA
          </Tabs.Tab>
          <Tabs.Tab value="storage" leftSection={<IconDatabase size={16} />}>
            Stockage S3 & Blobs
          </Tabs.Tab>
          <Tabs.Tab value="git" leftSection={<IconGitBranch size={16} />}>
            Dépôt Git & Données OKF
          </Tabs.Tab>
          <Tabs.Tab value="auth" leftSection={<IconShieldCheck size={16} />}>
            Sécurité & Auth
          </Tabs.Tab>
        </Tabs.List>

        {/* Tab 1: LLM */}
        <Tabs.Panel value="llm">
          <Stack gap="md">
            <Paper p="md" withBorder style={{ backgroundColor: '#161b22', borderColor: '#30363d' }}>
              <Text size="sm" fw={600} mb="xs" c="dimmed">
                Configuration du Moteur d'Ingestion Sémantique
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                <Select
                  label="Fournisseur LLM"
                  description="Adapter IA actif"
                  data={[
                    { value: 'gemini', label: 'Google Gemini (Natif)' },
                    { value: 'ollama', label: 'Ollama (Local / On-Premise)' },
                    { value: 'openai', label: 'OpenAI Compatible' }
                  ]}
                  value={llmProvider}
                  onChange={(val) => setLlmProvider(val || 'gemini')}
                />
                <Select
                  label="Modèle par défaut"
                  description="Utilisé pour le multi-axial tagging"
                  data={[
                    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Recommandé)' },
                    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (Précision élevée)' },
                    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' }
                  ]}
                  value={llmModel}
                  onChange={(val) => setLlmModel(val || 'gemini-2.5-flash')}
                />
              </SimpleGrid>

              <PasswordInput
                label="Clé API Gemini (GEMINI_API_KEY)"
                description="Clé secrète utilisée par les workers de file d'attente"
                placeholder="AIzaSy..."
                value={geminiApiKey}
                onChange={(e) => setGeminiApiKey(e.currentTarget.value)}
                mt="md"
              />
            </Paper>
          </Stack>
        </Tabs.Panel>

        {/* Tab 2: Storage S3 */}
        <Tabs.Panel value="storage">
          <Stack gap="md">
            <Paper p="md" withBorder style={{ backgroundColor: '#161b22', borderColor: '#30363d' }}>
              <Text size="sm" fw={600} mb="xs" c="dimmed">
                Stockage des Fichiers Originaux (PDFs, Images, Audio)
              </Text>
              <Select
                label="Type de stockage"
                data={[
                  { value: 'local', label: 'Stockage Local (Disque / assets)' },
                  { value: 's3', label: 'Objet S3 / MinIO / Scaleway' }
                ]}
                value={storageType}
                onChange={(val) => setStorageType(val || 'local')}
                mb="md"
              />

              {storageType === 'local' ? (
                <TextInput
                  label="Chemin absolu du dossier de stockage"
                  description="Emplacement local de conservation des fichiers originaux"
                  value={docStoragePath}
                  onChange={(e) => setDocStoragePath(e.currentTarget.value)}
                />
              ) : (
                <Stack gap="sm">
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                    <TextInput
                      label="S3 Bucket"
                      placeholder="world-agronomy"
                      value={s3Bucket}
                      onChange={(e) => setS3Bucket(e.currentTarget.value)}
                    />
                    <TextInput
                      label="S3 Région"
                      placeholder="fr-par / us-east-1"
                      value={s3Region}
                      onChange={(e) => setS3Region(e.currentTarget.value)}
                    />
                  </SimpleGrid>
                  <TextInput
                    label="S3 Endpoint personnalisé (optionnel)"
                    placeholder="https://s3.fr-par.scw.cloud"
                    value={s3Endpoint}
                    onChange={(e) => setS3Endpoint(e.currentTarget.value)}
                  />
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                    <PasswordInput
                      label="S3 Access Key"
                      value={s3AccessKey}
                      onChange={(e) => setS3AccessKey(e.currentTarget.value)}
                    />
                    <PasswordInput
                      label="S3 Secret Key"
                      value={s3SecretKey}
                      onChange={(e) => setS3SecretKey(e.currentTarget.value)}
                    />
                  </SimpleGrid>
                </Stack>
              )}
            </Paper>
          </Stack>
        </Tabs.Panel>

        {/* Tab 3: Git & OKF */}
        <Tabs.Panel value="git">
          <Stack gap="md">
            <Paper p="md" withBorder style={{ backgroundColor: '#161b22', borderColor: '#30363d' }}>
              <Text size="sm" fw={600} mb="xs" c="dimmed">
                Dépôt d'Autorité Scientifique (Source of Authority)
              </Text>
              <TextInput
                label="Chemin local du dépôt d'autorité (GIT_LOCAL_PATH)"
                description="Répertoire contenant les fiches OKF v0.1"
                value={gitLocalPath}
                onChange={(e) => setGitLocalPath(e.currentTarget.value)}
                mb="sm"
              />
              <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
                <TextInput
                  label="Organisation Git"
                  value={gitRepoOwner}
                  onChange={(e) => setGitRepoOwner(e.currentTarget.value)}
                />
                <TextInput
                  label="Dépôt Git"
                  value={gitRepoName}
                  onChange={(e) => setGitRepoName(e.currentTarget.value)}
                />
                <TextInput
                  label="Branche active"
                  value={gitBranch}
                  onChange={(e) => setGitBranch(e.currentTarget.value)}
                />
              </SimpleGrid>
            </Paper>
          </Stack>
        </Tabs.Panel>

        {/* Tab 4: Auth & Security */}
        <Tabs.Panel value="auth">
          <Stack gap="md">
            <Paper p="md" withBorder style={{ backgroundColor: '#161b22', borderColor: '#30363d' }}>
              <Text size="sm" fw={600} mb="xs" c="dimmed">
                Gouvernance d'Accès & Fournisseur d'Identité
              </Text>
              <TextInput
                label="URL du projet Supabase Auth"
                value={supabaseUrl}
                disabled
                mb="sm"
              />
              <TextInput
                label="Domaine email autorisé"
                description="Les connexions avec d'autres domaines sont rejetées par le middleware"
                value={allowedDomain}
                disabled
                mb="sm"
              />
              <Group gap="xs" mt="md">
                <Badge color="yellow">admin : Privilèges complets (Push Git, Paramètres)</Badge>
                <Badge color="blue">curator : Curateur (Ingestion, Écriture fiches OKF)</Badge>
              </Group>
            </Paper>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      <Divider my="lg" color="#30363d" />

      <Group justify="space-between">
        <Button variant="subtle" color="gray" onClick={onClose}>
          Fermer
        </Button>
        <Button
          color="yellow"
          leftSection={<IconDeviceFloppy size={16} />}
          onClick={handleSave}
          loading={saving}
        >
          Enregistrer les Paramètres
        </Button>
      </Group>
    </Modal>
  );
}
