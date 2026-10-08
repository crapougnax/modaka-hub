import React, { useState, useEffect, useMemo } from 'react';
import {
  MantineProvider,
  AppShell,
  Group,
  Text,
  Badge,
  Button,
  Stack,
  Paper,
  ActionIcon,
  Modal,
  TextInput,
  Textarea,
  Select,
  Tabs,
  ScrollArea,
  Card,
  Divider,
  Box,
  Notification,
  Title,
  Tooltip,
  TagsInput,
  SimpleGrid,
  ThemeIcon,
  Table,
  Avatar
} from '@mantine/core';
import {
  IconBook2,
  IconGitBranch,
  IconPlus,
  IconRefresh,
  IconUpload,
  IconFileText,
  IconFileTypePdf,
  IconCheck,
  IconFolder,
  IconSparkles,
  IconArrowRight,
  IconDeviceFloppy,
  IconDownload,
  IconActivity,
  IconThumbUp,
  IconThumbDown,
  IconPlant,
  IconMapPin,
  IconWorld,
  IconLogout,
  IconSettings
} from '@tabler/icons-react';
import { TaxonomyController, ThematicTree, ThematicBadgeGroup, type TaxonomyNode } from '@quatrain/ux-taxonomy';
import { FileIngestDropzone, type IngestFileItem } from '@quatrain/ux-dropzone';
import { CurationCard, type OKFDocumentMetadata, OKFMetadataForm, ContextExtractionModal, type UserContextProfile } from '@quatrain/ux-curation';
import { AdminSettingsModal } from './AdminSettingsModal';

interface CurationWorkbenchProps {
  initialUser?: {
    name?: string;
    email?: string;
    roles?: string[];
    isAdmin?: boolean;
  } | null;
}

export function CurationWorkbench({ initialUser }: CurationWorkbenchProps = {}) {
  const [thematics, setThematics] = useState<TaxonomyNode[]>([]);
  const [axes, setAxes] = useState<any[]>([]);
  const [axisFilters, setAxisFilters] = useState<Record<string, string>>({});
  const [selectedThematicId, setSelectedThematicId] = useState<string>('all');
  const [documents, setDocuments] = useState<OKFDocumentMetadata[]>([]);
  const [activeDocument, setActiveDocument] = useState<OKFDocumentMetadata | null>(null);
  const [queueTasks, setQueueTasks] = useState<IngestFileItem[]>([]);
  const [gitStatus, setGitStatus] = useState<any>({ branch: 'feat/bookworm-poc', isClean: true, uncommittedFiles: [] });
  const [isNewThematicOpen, setIsNewThematicOpen] = useState(false);
  const [isExtractionOpen, setIsExtractionOpen] = useState(false);
  const [isAdminSettingsOpen, setIsAdminSettingsOpen] = useState(false);
  const [newThematicLabel, setNewThematicLabel] = useState('');
  const [newThematicDesc, setNewThematicDesc] = useState('');
  const [activeTab, setActiveTab] = useState<string | null>('ingest');
  const [notification, setNotification] = useState<{ title: string; message: string; color: string } | null>(null);
  const [transversalThematics, setTransversalThematics] = useState<string[]>([]);
  const [saveLoading, setSaveLoading] = useState(false);
  const [extractLoading, setExtractLoading] = useState(false);
  const [telemetryData, setTelemetryData] = useState<any>({ totalInteractions: 0, recordedDocuments: 0, stats: [] });
  const [currentSoa, setCurrentSoa] = useState<string>('modaka/authority');
  const [currentUser, setCurrentUser] = useState<{ name: string; email: string; roles: string[]; isAdmin?: boolean } | null>(
    initialUser
      ? {
          name: initialUser.name || initialUser.email || 'Utilisateur',
          email: initialUser.email || '',
          roles: initialUser.roles || [],
          isAdmin: initialUser.isAdmin
        }
      : null
  );

  // Multi-axial filters
  const [selectedSoil, setSelectedSoil] = useState<string | null>(null);
  const [selectedClimate, setSelectedClimate] = useState<string | null>(null);
  const [selectedItinerary, setSelectedItinerary] = useState<string | null>(null);
  const [selectedCrop, setSelectedCrop] = useState<string | null>(null);

  const taxonomyController = useMemo(() => {
    return new TaxonomyController({
      initialNodes: thematics,
      selectedId: selectedThematicId === 'all' ? null : selectedThematicId
    });
  }, [thematics]);

  // Load initial data

  const loadUser = async () => {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.user) {
          setCurrentUser(data.user);
        }
      }
    } catch (e) {
      console.error('Failed to load user:', e);
    }
  };

  const loadThematics = async () => {
    try {
      const res = await fetch('/api/taxonomies');
      const data = await res.json();
      if (data.soa) setCurrentSoa(data.soa);
      if (data.axes) setAxes(data.axes);
      if (data.thematics) {
        setThematics(data.thematics);
        taxonomyController.loadNodes(data.thematics);
      }
    } catch (e) {
      console.error('Failed to load thematics:', e);
    }
  };

  const loadDocuments = async () => {
    try {
      let url = '/api/curate?';
      if (selectedThematicId && selectedThematicId !== 'all') url += `category=${selectedThematicId}&`;
      Object.entries(axisFilters).forEach(([axKey, axVal]) => {
        if (axVal) url += `${axKey}=${encodeURIComponent(axVal)}&`;
      });

      const res = await fetch(url);
      const data = await res.json();
      if (data.items) {
        setDocuments(data.items);
      }
    } catch (e) {
      console.error('Failed to load documents:', e);
    }
  };

  const loadGitStatus = async () => {
    try {
      const res = await fetch('/api/git/status');
      const data = await res.json();
      setGitStatus(data);
    } catch (e) {
      console.error('Failed to load git status:', e);
    }
  };

  const loadTelemetry = async () => {
    try {
      const res = await fetch('/api/telemetry');
      const data = await res.json();
      setTelemetryData(data);
    } catch (e) {
      console.error('Failed to load telemetry:', e);
    }
  };

  const refreshAll = async () => {
    await Promise.all([loadUser(), loadThematics(), loadDocuments(), loadGitStatus(), loadTelemetry()]);
  };

  useEffect(() => {
    loadUser();
    refreshAll();
    const interval = setInterval(async () => {
      try {
        const qRes = await fetch('/api/queue/status');
        const qData = await qRes.json();
        if (qData.tasks) {
          setQueueTasks(qData.tasks.map((t: any) => ({
            id: t.id,
            name: t.name,
            size: 0,
            type: t.type,
            status: t.status === 'processing' ? 'uploading' : t.status === 'completed' ? 'ready' : t.status,
            progress: t.progress,
            error: t.error
          })));
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [selectedThematicId, axisFilters]);

  const handleSelectThematic = (node: TaxonomyNode) => {
    setSelectedThematicId(node.id);
  };

  const handleCreateThematic = async () => {
    if (!newThematicLabel.trim()) return;
    const slug = newThematicLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    try {
      const res = await fetch('/api/taxonomies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: slug,
          label: newThematicLabel,
          description: newThematicDesc
        })
      });
      if (res.ok) {
        setIsNewThematicOpen(false);
        setNewThematicLabel('');
        setNewThematicDesc('');
        setNotification({
          title: 'Thématique créée',
          message: `La thématique "${newThematicLabel}" a été créée avec succès.`,
          color: 'green'
        });
        await refreshAll();
      }
    } catch (e: any) {
      setNotification({
        title: 'Erreur',
        message: e.message,
        color: 'red'
      });
    }
  };

  const handleUploadFiles = async (files: File[]) => {
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    formData.append('category', selectedThematicId === 'all' ? 'soil-health' : selectedThematicId);
    formData.append('thematics', JSON.stringify(transversalThematics.length > 0 ? transversalThematics : [selectedThematicId]));
    formData.append('soa', currentSoa);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        setNotification({
          title: 'Documents ajoutés à la file',
          message: `${files.length} document(s) sont en cours d'ingestion et structuration IA.`,
          color: 'blue'
        });
      }
    } catch (e: any) {
      setNotification({
        title: 'Erreur d\'upload',
        message: e.message,
        color: 'red'
      });
    }
  };

  const handleSaveMetadata = async (metadata: OKFDocumentMetadata) => {
    setSaveLoading(true);
    try {
      const res = await fetch('/api/curate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata)
      });
      const data = await res.json();
      if (data.success) {
        setNotification({
          title: 'Fiche OKF enregistrée & commitée',
          message: `Document "${metadata.title}" mis à jour avec SOA: ${metadata.soa || currentSoa}.`,
          color: 'green'
        });
        setActiveDocument(null);
        await refreshAll();
      }
    } catch (e: any) {
      setNotification({
        title: 'Erreur de sauvegarde',
        message: e.message,
        color: 'red'
      });
    } finally {
      setSaveLoading(false);
    }
  };

  const handleExecuteExtraction = async (profile: UserContextProfile) => {
    setExtractLoading(true);
    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      });
      const data = await res.json();
      if (data.success) {
        setIsExtractionOpen(false);
        setNotification({
          title: 'Extraction Contextuelle Réussie',
          message: `${data.extractedCount} fiches agronomiques exportées vers ${data.destinationPath} avec SOA ${data.soa}.`,
          color: 'green'
        });
      } else {
        throw new Error(data.error || 'Erreur lors de l\'extraction');
      }
    } catch (e: any) {
      setNotification({
        title: 'Erreur d\'extraction',
        message: e.message,
        color: 'red'
      });
    } finally {
      setExtractLoading(false);
    }
  };

  return (
    <MantineProvider defaultColorScheme="dark">
      <AppShell
        header={{ height: 60 }}
        navbar={{ width: 320, breakpoint: 'sm' }}
        padding="md"
      >
        {/* Header */}
        <AppShell.Header p="xs">
          <Group justify="space-between" h="100%">
            <Group gap="sm">
              <IconBook2 size={28} color="var(--mantine-color-green-5)" />
              <div>
                <Text fw={800} size="lg" c="white" style={{ letterSpacing: -0.5 }}>
                  Modaka-Hub <Badge size="xs" color="green" variant="filled">Curation Workbench</Badge>
                </Text>
                <Text size="xs" c="dimmed">
                  Curation Multi-Axiale & Structuration OKF v0.1
                </Text>
              </div>
            </Group>

            <Group gap="md">
              <Badge
                variant="outline"
                color="blue"
                leftSection={<IconWorld size={12} />}
              >
                SOA: {currentSoa}
              </Badge>

              <Button
                size="xs"
                color="green"
                variant="light"
                leftSection={<IconDownload size={14} />}
                onClick={() => setIsExtractionOpen(true)}
              >
                Extraire pour Client
              </Button>

              <Badge
                color={gitStatus.isClean ? 'teal' : 'yellow'}
                variant="light"
                leftSection={<IconGitBranch size={12} />}
              >
                {gitStatus.branch} {gitStatus.isClean ? '✓ Sync' : `● (${gitStatus.uncommittedFiles?.length || 0})`}
              </Badge>

              <Tooltip label="Rafraîchir les données">
                <ActionIcon variant="subtle" color="gray" onClick={refreshAll}>
                  <IconRefresh size={18} />
                </ActionIcon>
              </Tooltip>

              {currentUser && (
                <Group gap="xs" style={{ borderLeft: "1px solid rgba(48, 54, 61, 0.8)", paddingLeft: "12px" }}>
                  <Avatar color="green" radius="xl" size="sm">
                    {currentUser.name ? currentUser.name.substring(0, 2).toUpperCase() : "BR"}
                  </Avatar>
                  <Box visibleFrom="xs">
                    <Group gap={6} align="center">
                      <Text size="xs" fw={700} c="white" style={{ lineHeight: 1.2 }}>
                        {currentUser.name}
                      </Text>
                      {currentUser.roles?.includes('admin') || currentUser.roles?.includes('admin-brad') ? (
                        <Badge size="xs" color="yellow" variant="light">Admin</Badge>
                      ) : (
                        <Badge size="xs" color="teal" variant="light">Curateur</Badge>
                      )}
                    </Group>
                    <Text size="10px" c="dimmed" style={{ lineHeight: 1.1 }}>
                      {currentUser.email}
                    </Text>
                  </Box>
                </Group>
              )}

              {(currentUser?.roles?.includes('admin') || currentUser?.roles?.includes('admin-brad') || currentUser?.isAdmin) && (
                <Tooltip label="Paramètres Système (LLM, S3, Git, Auth)">
                  <ActionIcon
                    variant="light"
                    color="yellow"
                    size="md"
                    radius="md"
                    onClick={() => setIsAdminSettingsOpen(true)}
                  >
                    <IconSettings size={18} />
                  </ActionIcon>
                </Tooltip>
              )}

              <Tooltip label="Se déconnecter de Modaka-Hub">
                <Button
                  component="a"
                  href="/api/auth/logout"
                  size="xs"
                  color="red"
                  variant="subtle"
                  leftSection={<IconLogout size={14} />}
                >
                  Déconnexion
                </Button>
              </Tooltip>
            </Group>
          </Group>
        </AppShell.Header>

        {/* Sidebar / Left Tree */}
        <AppShell.Navbar p="md">
          <Stack gap="md" h="100%">
            <Group justify="space-between">
              <Text fw={700} size="sm" c="dimmed">
                THÉMATIQUES AGRO
              </Text>
              <Button
                size="compact-xs"
                variant="light"
                color="green"
                leftSection={<IconPlus size={12} />}
                onClick={() => setIsNewThematicOpen(true)}
              >
                Nouvelle
              </Button>
            </Group>

            <ScrollArea flex={1}>
              <ThematicTree
                controller={taxonomyController}
                nodes={thematics}
                selectedId={selectedThematicId}
                onSelect={handleSelectThematic}
              />
            </ScrollArea>

            <Divider />

            {/* Dynamic Multi-Axial Filter Facets */}
            <Stack gap="xs">
              <Group justify="space-between">
                <Text fw={700} size="xs" c="dimmed">
                  AXES DÉCLARÉS & ÉVOLUTIFS
                </Text>
                {Object.keys(axisFilters).length > 0 && (
                  <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setAxisFilters({})}>
                    Effacer
                  </Button>
                )}
              </Group>
              {axes.map((axis) => {
                const options = [
                  { value: '', label: `Tous (${axis.label})` },
                  ...(axis.items?.map((it) => ({
                    value: it.slug || it.id,
                    label: it.title || it.label
                  })) || [])
                ];
                return (
                  <Select
                    key={axis.id}
                    size="xs"
                    placeholder={axis.label}
                    data={options}
                    value={axisFilters[axis.id] || ''}
                    onChange={(v) => {
                      setAxisFilters(prev => {
                        const updated = { ...prev };
                        if (!v) delete updated[axis.id];
                        else updated[axis.id] = v;
                        return updated;
                      });
                    }}
                    clearable
                  />
                );
              })}
            </Stack>
          </Stack>
        </AppShell.Navbar>

        {/* Main Content Area */}
        <AppShell.Main>
          {notification && (
            <Notification
              title={notification.title}
              color={notification.color}
              onClose={() => setNotification(null)}
              mb="md"
            >
              {notification.message}
            </Notification>
          )}

          <Tabs value={activeTab} onChange={setActiveTab}>
            <Tabs.List mb="md">
              <Tabs.Tab value="ingest" leftSection={<IconUpload size={16} />}>
                Ingestion & Curation ({documents.length})
              </Tabs.Tab>
              <Tabs.Tab value="telemetry" leftSection={<IconActivity size={16} />}>
                Télémétrie & Retours ({telemetryData.totalInteractions})
              </Tabs.Tab>
            </Tabs.List>

            {/* TAB 1: Ingestion & Curation */}
            <Tabs.Panel value="ingest">
              <SimpleGrid cols={{ base: 1, md: activeDocument ? 2 : 1 }} spacing="md">
                {/* Left Panel: Dropzone & Document List */}
                <Stack gap="md">
                  <Paper withBorder p="md" radius="md">
                    <Group justify="space-between" mb="xs">
                      <Group gap="xs">
                        <IconSparkles size={18} color="var(--mantine-color-green-5)" />
                        <Text fw={700} size="sm">
                          Ingérer des publications ou guides agronomiques
                        </Text>
                      </Group>
                      <Badge size="xs" color="gray">
                        Dossier cible: {selectedThematicId}
                      </Badge>
                    </Group>

                    <FileIngestDropzone
                      tasks={queueTasks}
                      items={queueTasks}
                      onDropFiles={handleUploadFiles}
                    />
                  </Paper>

                  {/* Curated Documents List */}
                  <Paper withBorder p="md" radius="md">
                    <Group justify="space-between" mb="sm">
                      <Text fw={700} size="sm">
                        Documents Curés dans le Dépôt OKF ({documents.length})
                      </Text>
                    </Group>

                    {documents.length === 0 ? (
                      <Text c="dimmed" size="sm" ta="center" py="xl">
                        Aucun document trouvé pour les filtres sélectionnés. Déposez un PDF ci-dessus pour l'ingérer.
                      </Text>
                    ) : (
                      <Stack gap="sm">
                        {documents.map((doc) => (
                          <Paper
                            key={doc.id}
                            withBorder
                            p="sm"
                            radius="sm"
                            style={{
                              cursor: 'pointer',
                              borderColor: activeDocument?.id === doc.id ? 'var(--mantine-color-green-6)' : undefined
                            }}
                            onClick={() => setActiveDocument(doc)}
                          >
                            <Group justify="space-between" align="flex-start">
                              <Stack gap={4} flex={1}>
                                <Group gap="xs">
                                  <Badge size="xs" color="blue">
                                    {doc.category}
                                  </Badge>
                                  <Badge size="xs" variant="outline" color="gray">
                                    {doc.soa || currentSoa}
                                  </Badge>
                                  <Text size="xs" c="dimmed">
                                    {doc.revision || 'rev-1.0.0'}
                                  </Text>
                                </Group>
                                <Text fw={700} size="sm">
                                  {doc.title}
                                </Text>
                                <Text size="xs" c="dimmed" lineClamp={2}>
                                  {doc.description || doc.body?.substring(0, 150)}
                                </Text>
                                <Group gap={4} mt={4}>
                                  {doc.soils?.map((s) => (
                                    <Badge key={s} size="xs" color="amber" variant="light">
                                      {s}
                                    </Badge>
                                  ))}
                                  {doc.climates?.map((c) => (
                                    <Badge key={c} size="xs" color="cyan" variant="light">
                                      {c}
                                    </Badge>
                                  ))}
                                  {doc.itineraries?.map((it) => (
                                    <Badge key={it} size="xs" color="green" variant="light">
                                      {it}
                                    </Badge>
                                  ))}
                                  {doc.crops?.map((cr: string) => (
                                    <Badge key={cr} size="xs" color="lime" variant="light">
                                      {cr}
                                    </Badge>
                                  ))}
                                </Group>
                              </Stack>
                              <ActionIcon variant="subtle" color="green">
                                <IconArrowRight size={16} />
                              </ActionIcon>
                            </Group>
                          </Paper>
                        ))}
                      </Stack>
                    )}
                  </Paper>
                </Stack>

                {/* Right Panel: Metadata & OKF Editor */}
                {activeDocument && (
                  <Paper withBorder p="md" radius="md">
                    <Group justify="space-between" mb="sm">
                      <Group gap="xs">
                        <IconFileText size={18} color="var(--mantine-color-blue-5)" />
                        <Text fw={700} size="sm">
                          Éditeur de Métadonnées OKF & Frontmatter
                        </Text>
                      </Group>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        onClick={() => setActiveDocument(null)}
                      >
                        Fermer
                      </Button>
                    </Group>

                    <OKFMetadataForm
                      initialValues={activeDocument}
                      thematics={thematics}
                      axes={axes}
                      onSave={handleSaveMetadata}
                      loading={saveLoading}
                    />
                  </Paper>
                )}
              </SimpleGrid>
            </Tabs.Panel>

            {/* TAB 2: Telemetry & Feedback */}
            <Tabs.Panel value="telemetry">
              <Stack gap="md">
                <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
                  <Paper withBorder p="md" radius="md">
                    <Group justify="space-between">
                      <Text size="xs" c="dimmed" fw={700}>
                        TOTAL INTERACTIONS
                      </Text>
                      <ThemeIcon color="blue" variant="light" size="sm">
                        <IconActivity size={16} />
                      </ThemeIcon>
                    </Group>
                    <Text fw={800} size="xl" mt="xs">
                      {telemetryData.totalInteractions}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Requêtes posées aux Agents IA
                    </Text>
                  </Paper>

                  <Paper withBorder p="md" radius="md">
                    <Group justify="space-between">
                      <Text size="xs" c="dimmed" fw={700}>
                        FICHES MOBILISÉES
                      </Text>
                      <ThemeIcon color="green" variant="light" size="sm">
                        <IconBook2 size={16} />
                      </ThemeIcon>
                    </Group>
                    <Text fw={800} size="xl" mt="xs">
                      {telemetryData.recordedDocuments}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Fiches injectées dans le contexte IA
                    </Text>
                  </Paper>

                  <Paper withBorder p="md" radius="md">
                    <Group justify="space-between">
                      <Text size="xs" c="dimmed" fw={700}>
                        SOURCE D'AUTORITÉ CERTIFIÉE
                      </Text>
                      <ThemeIcon color="teal" variant="light" size="sm">
                        <IconCheck size={16} />
                      </ThemeIcon>
                    </Group>
                    <Text fw={800} size="md" mt="xs">
                      {currentSoa}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Référentiel souverain OKF v0.2
                    </Text>
                  </Paper>
                </SimpleGrid>

                <Paper withBorder p="md" radius="md">
                  <Title order={4} mb="md">
                    Statistiques d'Usage par Fiche (Remontées Clients & Agents)
                  </Title>

                  {telemetryData.stats.length === 0 ? (
                    <Text c="dimmed" size="sm" ta="center" py="xl">
                      Aucune donnée de télémétrie enregistrée pour le moment.
                    </Text>
                  ) : (
                    <Table striped highlightOnHover>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Fiche / Document UID</Table.Th>
                          <Table.Th>SOA & Révision</Table.Th>
                          <Table.Th>Consultations</Table.Th>
                          <Table.Th>Votes Utilité</Table.Th>
                          <Table.Th>Mots-Clés de Contexte</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {telemetryData.stats.map((row: any) => (
                          <Table.Tr key={row.documentUid}>
                            <Table.Td fw={700}>{row.documentUid}</Table.Td>
                            <Table.Td>
                              <Badge size="xs" variant="outline">{row.soa}</Badge> {row.revision}
                            </Table.Td>
                            <Table.Td>{row.totalUsages}</Table.Td>
                            <Table.Td>
                              <Group gap="xs">
                                <Badge size="xs" color="green" leftSection={<IconThumbUp size={10} />}>
                                  +{row.helpfulVotes}
                                </Badge>
                                <Badge size="xs" color="red" leftSection={<IconThumbDown size={10} />}>
                                  -{row.unhelpfulVotes}
                                </Badge>
                              </Group>
                            </Table.Td>
                            <Table.Td>
                              <Group gap={4}>
                                {row.keywords?.slice(0, 3).map((kw: string) => (
                                  <Badge key={kw} size="xs" color="gray" variant="light">
                                    {kw}
                                  </Badge>
                                ))}
                              </Group>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  )}
                </Paper>
              </Stack>
            </Tabs.Panel>
          </Tabs>
        </AppShell.Main>

        {/* Modal: New Thematic Category */}
        <Modal
          opened={isNewThematicOpen}
          onClose={() => setIsNewThematicOpen(false)}
          title="Créer une nouvelle thématique agronomique"
          size="md"
        >
          <Stack gap="md">
            <TextInput
              label="Nom de la thématique"
              placeholder="Ex: Agroforesterie Intra-parcellaire"
              value={newThematicLabel}
              onChange={(e) => setNewThematicLabel(e.currentTarget.value)}
              required
            />
            <Textarea
              label="Description"
              placeholder="Arbres fruitiers, haies brise-vent, ombrage..."
              value={newThematicDesc}
              onChange={(e) => setNewThematicDesc(e.currentTarget.value)}
              minRows={3}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setIsNewThematicOpen(false)}>
                Annuler
              </Button>
              <Button color="green" onClick={handleCreateThematic}>
                Créer la thématique
              </Button>
            </Group>
          </Stack>
        </Modal>

        {/* Modal: Contextual Extraction for User X */}
        <ContextExtractionModal
          opened={isExtractionOpen}
          onClose={() => setIsExtractionOpen(false)}
          onExtract={handleExecuteExtraction}
          loading={extractLoading}
        />

        {/* Modal: Admin System Settings */}
        <AdminSettingsModal
          opened={isAdminSettingsOpen}
          onClose={() => setIsAdminSettingsOpen(false)}
        />
      </AppShell>
    </MantineProvider>
  );
}
