export type DriverInstallerActor = 'desktop-app' | 'installer' | 'bridge-service' | 'driver';

export type DriverInstallerStep = {
  id: string;
  title: string;
  actor: DriverInstallerActor;
  detail: string;
  recoveryCondition: string;
};

export type DriverInstallerBranchNotes = {
  channel: 'development' | 'release';
  notes: string[];
};

export type DriverInstallerErrorReference = {
  code: string;
  meaning: string;
  action: string;
};

export type DriverInstallerPlan = {
  elevationTrigger: string;
  installOrder: string[];
  installSteps: DriverInstallerStep[];
  rollbackSteps: DriverInstallerStep[];
  branchNotes: DriverInstallerBranchNotes[];
  errors: DriverInstallerErrorReference[];
};