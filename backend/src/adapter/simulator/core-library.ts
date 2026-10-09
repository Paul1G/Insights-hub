// adapter/simulator/core-library holds the Insights Hub OOTB ('core') aspect
// and asset types that every simulated tenant is seeded with. The data is
// ported from apps/web/src/domain/coreLibrary.ts, which transcribes
// docs/reference/basic-types.txt. Core types are public and read-only.

export type CoreDataType =
  | 'BOOLEAN'
  | 'INT'
  | 'LONG'
  | 'DOUBLE'
  | 'STRING'
  | 'TIMESTAMP'
  | 'BIG_STRING';

export interface CoreVariable {
  name: string;
  dataType: CoreDataType;
  unit: string | null;
  searchable: boolean;
  length: number | null;
  defaultValue: string | null;
  qualityCode?: boolean;
}

export interface CoreAspectType {
  id: string;
  name: string;
  category: 'static' | 'dynamic';
  description: string;
  variables: CoreVariable[];
}

export interface CoreAssetType {
  id: string;
  name: string;
  description: string;
  parentTypeId: string | null;
  instantiable: boolean;
  variables: CoreVariable[];
  aspects: { name: string; aspectTypeId: string }[];
  deprecated?: boolean;
}

export const BASIC_ASSET_TYPE_ID = 'core.basicasset';
export const ROOT_HIERARCHY_TYPE_ID = 'core.roothierarchy';
export const ROOT_ASSET_TYPE_ID = 'core.basicenterprise';

function str(name: string, searchable = true, length = 255): CoreVariable {
  return {
    name,
    dataType: 'STRING',
    unit: null,
    searchable,
    length,
    defaultValue: null,
  };
}

function v(
  name: string,
  dataType: CoreDataType,
  opts: {
    unit?: string;
    searchable?: boolean;
    length?: number;
    qualityCode?: boolean;
  } = {},
): CoreVariable {
  return {
    name,
    dataType,
    unit: opts.unit ?? null,
    searchable: opts.searchable ?? true,
    length: opts.length ?? null,
    defaultValue: null,
    qualityCode: opts.qualityCode ?? false,
  };
}

const ASPECT_TYPES: CoreAspectType[] = [
  {
    id: 'core.contactpoint',
    name: 'ContactPoint',
    category: 'static',
    description: 'Contact point definition for basic asset hierarchy type.',
    variables: [
      { ...str('telephoneNumber'), qualityCode: false },
      { ...str('faxNumber'), qualityCode: false },
      { ...str('email'), qualityCode: false },
      { ...str('contactType'), qualityCode: false },
    ],
  },
  {
    id: 'core.agentstatus',
    name: 'AgentOnlineStatus',
    category: 'dynamic',
    description: 'Online status of an agent typed asset.',
    variables: [v('onlineStatus', 'BOOLEAN', { searchable: false })],
  },
  {
    id: 'core.assetstatus',
    name: 'DeviceAssetStatus',
    category: 'static',
    description: 'Status of a device typed asset.',
    variables: [
      v('connection_timestamp', 'TIMESTAMP'),
      v('connection', 'INT'),
      v('health_unconfirmed', 'INT'),
      v('health_timestamp', 'TIMESTAMP'),
      v('health', 'INT'),
      v('health_unconfirmed_timestamp', 'TIMESTAMP'),
    ],
  },
  {
    id: 'core.sinumerikbasicconfig',
    name: 'SinumerikBasicConfig',
    category: 'dynamic',
    description: 'CH1_BasicConfig for Sinumerik typed asset.',
    variables: [
      v('NCProgramStatus', 'DOUBLE'),
      v('Spindleoverride', 'DOUBLE', { unit: '%' }),
      v('StopCond', 'DOUBLE'),
      v('ProtectionLevel', 'DOUBLE'),
      v('NCProgram', 'STRING', { length: 255 }),
      v('Opmode', 'DOUBLE'),
      v('NrOfAlarms', 'DOUBLE'),
      v('Feedoverride', 'DOUBLE', { unit: '%' }),
    ],
  },
  {
    id: 'core.sinumerikbasicalarms',
    name: 'SinumerikBasicAlarms',
    category: 'dynamic',
    description: 'Alarms for Sinumerik typed asset.',
    variables: [v('CurrentAlarms', 'BIG_STRING', { length: 100000 })],
  },
  {
    id: 'core.sinumerikbasicmachinemodel',
    name: 'SinumerikBasicMachineModel',
    category: 'dynamic',
    description: 'Machinemodel for Sinumerik typed asset.',
    variables: [v('Data', 'BIG_STRING', { length: 100000 })],
  },
  {
    id: 'core.sinumerikbasicmachinestatus',
    name: 'SinumerikBasicMachineStatus',
    category: 'dynamic',
    description: 'CH1_MachineStatus for Sinumerik typed asset.',
    variables: [v('MachineStatus', 'DOUBLE', { unit: '%' })],
  },
  {
    id: 'core.sinumerikbasicstartup',
    name: 'SinumerikBasicStartup',
    category: 'dynamic',
    description: 'Startup for Sinumerik typed asset.',
    variables: [
      v('shutdownTime', 'STRING', { length: 255 }),
      v('bootTime', 'STRING', { length: 255 }),
    ],
  },
  {
    id: 'core.edgeanalyticsapplicationstatus',
    name: 'EdgeAnalyticsApplicationStatus',
    category: 'dynamic',
    description: 'Status of the Edge Analytics Application',
    variables: [
      v('CPU_usage', 'INT', { unit: '%', searchable: false }),
      v('Project_state', 'BOOLEAN', { searchable: false }),
      v('Server_state', 'BOOLEAN', { searchable: false }),
    ],
  },
];

function agent(
  id: string,
  name: string,
  description: string,
  deprecated = false,
): CoreAssetType {
  return {
    id,
    name,
    description,
    parentTypeId: 'core.basicagent',
    instantiable: true,
    variables: [],
    aspects: [],
    ...(deprecated ? { deprecated } : {}),
  };
}

const ASSET_TYPES: CoreAssetType[] = [
  {
    id: BASIC_ASSET_TYPE_ID,
    name: 'BasicAsset',
    description: 'Base type for the Asset Management Service.',
    parentTypeId: null,
    instantiable: false,
    variables: [str('externalId')],
    aspects: [],
  },
  {
    id: 'core.basichierarchy',
    name: 'BasicHierarchy',
    description: 'Base hierarchy type for the Asset Management Service.',
    parentTypeId: BASIC_ASSET_TYPE_ID,
    instantiable: false,
    variables: [str('hierarchyModel')],
    aspects: [{ name: 'contactPoint', aspectTypeId: 'core.contactpoint' }],
  },
  {
    id: ROOT_HIERARCHY_TYPE_ID,
    name: 'RootHierarchy',
    description: 'Root type for asset hierarchy.',
    parentTypeId: 'core.basichierarchy',
    instantiable: false,
    variables: [],
    aspects: [],
  },
  {
    id: ROOT_ASSET_TYPE_ID,
    name: 'BasicEnterprise',
    description: 'Basic Enterprise type for the Asset Management Service',
    parentTypeId: ROOT_HIERARCHY_TYPE_ID,
    instantiable: true,
    variables: [
      str('sameAs'),
      str('legalName'),
      str('organizationType'),
      str('url'),
    ],
    aspects: [],
  },
  {
    id: 'core.basicsubtenant',
    name: 'BasicSubtenant',
    description: 'SubTenant type for the Asset Management Service',
    parentTypeId: ROOT_HIERARCHY_TYPE_ID,
    instantiable: true,
    variables: [str('displayName')],
    aspects: [],
  },
  {
    id: 'core.basicsite',
    name: 'BasicSite',
    description: 'Site type for creating asset hierarchy levels.',
    parentTypeId: 'core.basichierarchy',
    instantiable: true,
    variables: [],
    aspects: [],
  },
  {
    id: 'core.basicarea',
    name: 'BasicArea',
    description: 'Area type for creating asset hierarchy levels.',
    parentTypeId: 'core.basichierarchy',
    instantiable: true,
    variables: [],
    aspects: [],
  },
  {
    id: 'core.basicagent',
    name: 'BasicAgent',
    description: 'Basic agent type for the Asset Management Service.',
    parentTypeId: BASIC_ASSET_TYPE_ID,
    instantiable: false,
    variables: [],
    aspects: [{ name: 'status', aspectTypeId: 'core.agentstatus' }],
  },
  agent('core.mcnano', 'MindConnectNano', 'MindConnect Nano Agent asset type'),
  agent('core.mclib', 'MindConnectLib', 'MindConnect Lib Agent asset type'),
  agent(
    'core.mciot2040',
    'MindConnectIoT2040',
    'MindConnect IoT 2040 Agent asset type',
  ),
  agent(
    'core.mcfb1500',
    'MindConnectFB1500',
    'MindConnect FB 1500 Agent asset type',
    true,
  ),
  agent(
    'core.mcintegration',
    'MindConnectIntegration',
    'MindConnect Integration Agent asset type',
  ),
  agent(
    'core.industrialEdge',
    'IndustrialEdge',
    'Industrial Edge Agent asset type',
  ),
  {
    id: 'core.basicdevice',
    name: 'BasicDevice',
    description: 'Basic device asset type for the Asset Management Service.',
    parentTypeId: BASIC_ASSET_TYPE_ID,
    instantiable: false,
    variables: [str('manufacturer')],
    aspects: [{ name: 'status', aspectTypeId: 'core.assetstatus' }],
  },
  {
    id: 'core.basicsinumerikasset',
    name: 'BasicSinumerikAsset',
    description: 'Basic asset type for Sinumerik devices.',
    parentTypeId: 'core.basicdevice',
    instantiable: false,
    variables: [],
    aspects: [
      { name: 'CH1_BasicConfig', aspectTypeId: 'core.sinumerikbasicconfig' },
      { name: 'Alarms', aspectTypeId: 'core.sinumerikbasicalarms' },
      { name: 'MachineModel', aspectTypeId: 'core.sinumerikbasicmachinemodel' },
      {
        name: 'CH1_MachineStatus',
        aspectTypeId: 'core.sinumerikbasicmachinestatus',
      },
      { name: 'Startup', aspectTypeId: 'core.sinumerikbasicstartup' },
      { name: 'AgentOnlineStatus', aspectTypeId: 'core.agentstatus' },
    ],
  },
  {
    id: 'core.basicapplication',
    name: 'BasicApplication',
    description: 'Basic asset type for Applications',
    parentTypeId: BASIC_ASSET_TYPE_ID,
    instantiable: false,
    variables: [],
    aspects: [],
  },
  {
    id: 'core.edgebasicapplication',
    name: 'EdgeBasicApplication',
    description: 'Represents the root asset type for all edge applications',
    parentTypeId: 'core.basicapplication',
    instantiable: false,
    variables: [],
    aspects: [{ name: 'status', aspectTypeId: 'core.assetstatus' }],
  },
  {
    id: 'core.edgeanalyticsapplication',
    name: 'EdgeAnalyticsApplication',
    description:
      'Represents the Edge Analytics Application present on the Edge device',
    parentTypeId: 'core.edgebasicapplication',
    instantiable: true,
    variables: [],
    aspects: [
      {
        name: 'EdgeAnalyticsApplicationStatus',
        aspectTypeId: 'core.edgeanalyticsapplicationstatus',
      },
    ],
  },
  {
    id: 'core.edgedevice',
    name: 'EdgeDevice',
    description: 'Open Edge device asset type for Asset Management Service.',
    parentTypeId: BASIC_ASSET_TYPE_ID,
    instantiable: false,
    variables: [],
    aspects: [],
  },
];

export const CORE_ASPECT_TYPES: readonly CoreAspectType[] = ASPECT_TYPES;
export const CORE_ASSET_TYPES: readonly CoreAssetType[] = ASSET_TYPES;
