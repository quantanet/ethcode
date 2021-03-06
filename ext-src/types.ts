export interface ISource {
  content: string | undefined;
}
export interface ISources {
  [key: string]: ISource;
}
export interface IAccount {
  label: string;
  value: string;
  pubAddr?: string;
  checksumAddr?: string;
}

export type LocalAddressType = {
  pubAddress: string;
  checksumAddress: string;
};

export interface TokenData {
  appId?: string;
  token?: string;
  email?: string;
}

interface ISrcLoc {
  end: number;
  file: string;
  start: number;
}
export interface SolcError {
  component: string;
  errorCode: string;
  formattedMessage: string;
  message: string;
  severity: string;
  sourceLocation: ISrcLoc;
  type: string;
}

export interface ICompilationResult {
  source: {
    target: string;
    sources: ISources;
  };
  data: any;
}
