import * as path from 'path';
import { WebviewPanel, Disposable, ViewColumn, window, Uri, commands, ExtensionContext, workspace } from 'vscode';
import { fork, ChildProcess } from 'child_process';
import * as uuid from 'uuid/v4';
import axios from 'axios';
import {
  Logger,
  actionToast,
  updateUserSession,
  registerAppToToken,
  updateUserSettings,
  retrieveUserSettings,
  getNonce,
} from './utils';
import { ISources, TokenData, IAccount } from './types';

const logger = new Logger();

const authToken: TokenData = {
  token: retrieveUserSettings('ethcode.userConfig.appRegistration', 'token'),
  appId: retrieveUserSettings('ethcode.userConfig.appRegistration', 'appId'),
};

/**
 * Manages react webview panels
 */
// eslint-disable-next-line import/prefer-default-export
export class ReactPanel {
  /**
   * Track the currently panel. Only allow a single panel to exist at a time.
   */
  public static currentPanel: ReactPanel | undefined;

  private static readonly viewType = 'ethcode';

  private readonly _panel: WebviewPanel;

  private readonly _extensionPath: string;

  private _disposables: Disposable[] = [];

  private _disposed = false;

  // @ts-ignore
  private version: string;

  private constructor(extensionPath: string, column: ViewColumn) {
    this._extensionPath = extensionPath;

    // Create and show a new webview panel
    this._panel = window.createWebviewPanel(ReactPanel.viewType, 'ETHcode', column, {
      // Enable javascript in the webview
      enableScripts: true,

      // And restric the webview to only loading content from our extension's `media` directory.
      localResourceRoots: [Uri.file(path.join(this._extensionPath, 'build'))],
    });

    // Set the webview's initial html content
    this._panel.webview.html = this._getHtmlForWebview();

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message: any) => {
        logger.log(`Worker message: ${JSON.stringify(message)}`);
        if (message.command === 'version') {
          this.version = message.version;
        } else if (message.command === 'auth-updated') {
          const actionName = 'Reload';
          actionToast(
            'Authentication status updated. Please reload if you have changed your authtoken!',
            actionName
          ).then((item: string | undefined) => {
            if (item === actionName) commands.executeCommand('workbench.action.reloadWindow');
          });
        } else if (message.command === 'run-deploy') {
          this.runDeploy(message.payload, message.testNetId);
        } else if (message.command.endsWith('contract-method-call')) {
          this.runContractCall(message.payload, message.testNetId);
        } else if (message.command === 'run-get-gas-estimate') {
          this.runGetGasEstimate(message.payload, message.testNetId);
        } else if (message.command === 'debugTransaction') {
          this.debug(message.txHash, message.testNetId);
        } else if (message.command === 'get-balance') {
          updateUserSession(message.account, ['userConfig', 'defaultAccount']);
          this.getBalance(message.account, message.testNetId);
        } else if (message.command === 'build-rawtx') {
          this.buildRawTx(message.payload, message.testNetId);
        } else if (message.command === 'sign-deploy-tx') {
          this.signDeployTx(message.payload, message.testNetId);
        } else if (message.command === 'run-getAccounts') {
          if (ReactPanel.currentPanel) {
            ReactPanel.currentPanel.getAccounts();
          } else {
            try {
              ReactPanel.currentPanel = new ReactPanel(extensionPath, column || ViewColumn.One);
              ReactPanel.currentPanel.getAccounts();
            } catch (error) {
              logger.error(error);
            }
          }
        } else if (message.command === 'gen-keypair') {
          this.genKeyPair(message.payload, this._extensionPath);
        } else if (message.command === 'delete-keyPair') {
          this.deleteKeyPair(message.payload, this._extensionPath);
        } else if (message.command === 'get-localAccounts') {
          updateUserSession(this._extensionPath, ['keystore', 'keyStorePath']);
          this.getLocalAccounts(this._extensionPath);
        } else if (message.command === 'send-ether') {
          this.sendEther(message.payload, message.testNetId);
        } else if (message.command === 'send-ether-signed') {
          this.sendEtherSigned(message.payload, message.testNetId);
        } else if (message.command === 'get-pvt-key') {
          this.getPvtKey(message.payload, this._extensionPath);
        } else if (message.command === 'app-register') {
          this.getTokens()
            .then((r) => this._panel.webview.postMessage({ registered: r }))
            .catch(() => this._panel.webview.postMessage({ registered: false }));
        }
      },
      null,
      this._disposables
    );
  }

  public postMessage(msg: any) {
    this._panel.webview.postMessage(msg);
  }

  public static createOrShow(extensionPath: string) {
    const column = window.activeTextEditor ? -2 : undefined;

    // If we already have a panel, show it.
    // Otherwise, create a new panel.
    if (ReactPanel.currentPanel) {
      try {
        ReactPanel.currentPanel.getCompilerVersion();
        ReactPanel.currentPanel.version = 'latest';
        ReactPanel.currentPanel._panel.reveal(column);
        ReactPanel.currentPanel.checkFileName();
        ReactPanel.currentPanel.checkAppRegistration();
      } catch (error) {
        logger.error(error);
      }
    } else {
      try {
        ReactPanel.currentPanel = new ReactPanel(extensionPath, column || ViewColumn.One);
        ReactPanel.currentPanel.version = 'latest';
        ReactPanel.currentPanel.getCompilerVersion();
        ReactPanel.currentPanel.checkFileName();
        ReactPanel.currentPanel.checkAppRegistration();
      } catch (error) {
        logger.error(error);
      }
    }
  }

  public setSolidityVersion(selected: any) {
    this.version = selected;
  }

  public checkFileName() {
    window.onDidChangeActiveTextEditor((changeEvent) => {
      // @ts-ignore
      const panelName = changeEvent && changeEvent._documentData ? changeEvent._documentData._uri.fsPath : undefined;

      const regexVyp = /([a-zA-Z0-9\s_\\.\-\\(\\):])+(.vy|.v.py|.vyper.py)$/g;
      const regexSol = /([a-zA-Z0-9\s_\\.\-\\(\\):])+(.sol|.solidity)$/g;

      if (this._disposed) {
        // @ts-ignore
      } else if (panelName && panelName.match(regexVyp) && panelName.match(regexVyp).length > 0) {
        // @ts-ignore
        this._panel.webview.postMessage({ fileType: 'vyper' });
        // @ts-ignore
      } else if (panelName && panelName.match(regexSol) && panelName.match(regexSol).length > 0) {
        // @ts-ignore
        this._panel.webview.postMessage({ fileType: 'solidity' });
      } else {
        this._panel.webview.postMessage({ fileType: 'none' });
      }
    });
  }

  private createWorker = (): ChildProcess => {
    // enable --inspect for debug
    // return fork(path.join(__dirname, "worker.js"), [], {
    //   execArgv: ["--inspect=" + (process.debugPort + 1)]
    // });
    return fork(path.join(__dirname, 'worker.js'));
  };

  private createSolidityWorker = (): ChildProcess => {
    // enable --inspect for debug
    // return fork(path.join(__dirname, "solc-worker.js"), [], {
    //   execArgv: ["--inspect=" + (process.debugPort + 1)]
    // });
    return fork(path.join(__dirname, 'solc-worker.js'));
  };

  private createVyperWorker = (): ChildProcess => {
    // enable --inspect for debug
    // return fork(path.join(__dirname, "vyp-worker.js"), [], {
    //   execArgv: ["--inspect=" + (process.debugPort + 1)]
    // });
    return fork(path.join(__dirname, 'vyp-worker.js'));
  };

  private createAccWorker = (): ChildProcess => {
    // return fork(path.join(__dirname, 'accWorker.js'), [], {
    //   execArgv: [`--inspect=${process.debugPort + 1}`],
    // });
    return fork(path.join(__dirname, 'accWorker.js'));
  };

  public async checkAppRegistration(): Promise<void> {
    const registered = await registerAppToToken();
    this._panel.webview.postMessage({ registered });
  }

  public getTokens = async (): Promise<boolean> => {
    try {
      const token = await window.showInputBox({
        ignoreFocusOut: true,
        placeHolder: 'Enter App Token from dApp Auth',
      });
      const email = await window.showInputBox({
        ignoreFocusOut: true,
        placeHolder: 'Enter email regitered from dApp Auth',
      });
      if (token || email) {
        const appId = uuid();
        await axios.post('https://auth.ethcode.dev/user/token/app/add', {
          email,
          app_id: appId,
          token,
        });
        const settingsData = {
          appId,
          email,
          token,
        };
        await updateUserSettings('userConfig.appRegistration.token', settingsData.token!);
        await updateUserSettings('userConfig.appRegistration.appId', settingsData.appId!);
        await updateUserSettings('userConfig.appRegistration.email', settingsData.email!);
        return true;
      }
      return false;
    } catch (error) {
      logger.log(error);
      logger.log(error.response.data.Error);
      return false;
    }
  };

  private invokeSolidityCompiler(context: ExtensionContext, sources: ISources, rootPath: Uri): void {
    // solidity compiler code goes bellow
    const input = {
      language: 'Solidity',
      sources,
      settings: {
        outputSelection: {
          '*': {
            '*': ['*'],
          },
        },
      },
    };
    // child_process won't work because of debugging issue if launched with F5
    // child_process will work when launched with ctrl+F5
    // more on this - https://github.com/Microsoft/vscode/issues/40875
    const solcWorker = this.createSolidityWorker();
    logger.log(`Solidity compiler invoked with WorkerID: ${solcWorker.pid}`);
    logger.log(`Compiling with solidity version ${this.version}`);
    // Reset Components State before compilation
    this._panel.webview.postMessage({ processMessage: 'Compiling...' });
    solcWorker.send({
      command: 'compile',
      payload: input,
      version: this.version,
    });
    solcWorker.on('message', (m: any) => {
      logger.log(`Solidity worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        logger.error(m.error);
      } else if (m.command === 'import') {
        if (!sources[m.path]) {
          // eslint-disable-next-line no-param-reassign
          sources[m.path] = {
            content: undefined,
          };
          solcWorker.send({
            command: 'import',
            payload: {
              path: m.path,
              rootPath,
            },
          });
        }
      } else if (m.command === 're-compile') {
        if (m.path) {
          // eslint-disable-next-line no-param-reassign
          sources[m.path] = {
            content: m.data.content,
          };
          input.sources = sources;
          const noContent = Object.values(input.sources).filter((source) => source.content === undefined);
          if (noContent.length < 1) {
            solcWorker.send({
              command: 'compile',
              payload: input,
              version: this.version,
            });
          }
        }
      } else if (m.command === 'compiled') {
        context.workspaceState.update('sources', JSON.stringify(sources));
        this._panel.webview.postMessage({
          compiled: m.output,
          sources,
          testPanel: 'main',
        });
        updateUserSession(
          {
            lang: 'solidity',
            solidityCompilerVersion: this.version,
          },
          ['userConfig', 'compiler']
        );
      } else if (m.command === 'process') {
        this._panel.webview.postMessage({ processMessage: m.processMessage });
      } else if (m.command === 'compile-ok') {
        solcWorker.send({ command: 'exit' });
      }
    });
    solcWorker.on('error', (error: Error) => {
      logger.log(`Compile worker process exited with error ${error.message}`);
      solcWorker.kill();
    });
    solcWorker.on('exit', (code: number, signal: string) => {
      logger.log(`Compile worker process exited with code ${code} and signal ${signal}`);
      this._panel.webview.postMessage({ processMessage: '' });
    });
  }

  private invokeVyperCompiler(context: ExtensionContext, sources: ISources): void {
    const vyperWorker = this.createVyperWorker();
    logger.log(`Vyper compiler invoked with WorkerID: ${vyperWorker.pid}`);
    logger.log(`Compiling with vyper compiler version: ${this.version}`);
    this._panel.webview.postMessage({ processMessage: 'Compiling...' });
    vyperWorker.send({
      command: 'compile',
      source: sources,
      version: this.version,
    });
    vyperWorker.on('message', (m: any) => {
      logger.log(`Vyper worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        logger.error(m.error);
      }
      if (m.compiled) {
        context.workspaceState.update('sources', JSON.stringify(sources));

        this._panel.webview.postMessage({ compiled: m.compiled, sources });
        vyperWorker.kill();
        updateUserSession(
          {
            lang: 'vyper',
            solidityCompilerVersion: '',
          },
          ['userConfig', 'compiler']
        );
      }
      if (m.processMessage) {
        this._panel.webview.postMessage({ processMessage: m.processMessage });
      }
    });
  }

  private genKeyPair(password: string, ksPath: string): void {
    const accWorker = this.createAccWorker();
    logger.log(`Account worker invoked with WorkerID : ${accWorker.pid}.`);
    accWorker.on('message', (m: any) => {
      logger.log(`Account worker message: ${JSON.stringify(m)}`);
      if (m.account) {
        this._panel.webview.postMessage({ newAccount: m.account });
      }
      if (m.localAddresses) {
        this._panel.webview.postMessage({ localAccounts: m.localAddresses });
      } else if (m.error) {
        this._panel.webview.postMessage({ error: m.error });
      }
    });
    accWorker.send({ command: 'create-account', pswd: password, ksPath });
  }

  // get private key for given public key
  private getPvtKey(pubKey: string, keyStorePath: string) {
    const accWorker = this.createAccWorker();
    accWorker.on('message', (m: any) => {
      logger.log(`Account worker message: ${JSON.stringify(m)}`);
      // TODO: handle private key not found errors
      if (m.privateKey) {
        this._panel.webview.postMessage({ pvtKey: m.privateKey });
      }
    });
    accWorker.send({
      command: 'extract-privateKey',
      address: pubKey,
      keyStorePath,
      pswd: '',
    });
  }

  private deleteKeyPair(publicKey: string, keyStorePath: string) {
    const accWorker = this.createAccWorker();
    accWorker.on('message', (m: any) => {
      logger.log(`Account worker message: ${JSON.stringify(m)}`);
      if (m.resp) {
        logger.success(m.resp);
        this._panel.webview.postMessage({ resp: m.resp });
      } else {
        logger.error(m.error);
      }

      if (m.localAddresses) {
        this._panel.webview.postMessage({ localAccounts: m.localAddresses });
      }
    });
    accWorker.send({
      command: 'delete-keyPair',
      address: publicKey,
      keyStorePath,
    });
  }

  private debug(txHash: string, testNetId: string): void {
    const debugWorker = this.createWorker();
    logger.log(`Debug worker invoked with WorkerID: ${debugWorker.pid}`);
    debugWorker.on('message', (m: any) => {
      logger.log(`Debug worker message: ${JSON.stringify(m)}`);
      try {
        this._panel.webview.postMessage({ txTrace: JSON.parse(m.debugResp) });
      } catch (error) {
        this._panel.webview.postMessage({ traceError: m.debugResp });
      }
    });
    debugWorker.send({
      command: 'debug-transaction',
      payload: txHash,
      testnetId: testNetId,
    });
  }

  // create unsigned transactions
  private buildRawTx(payload: any, testNetId: string) {
    const txWorker = this.createWorker();
    txWorker.on('message', (m: any) => {
      logger.log(`Transaction worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        this._panel.webview.postMessage({ errors: m.error });
      } else {
        this._panel.webview.postMessage({ buildTxResult: m.buildTxResult });
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    txWorker.send({
      command: 'build-rawtx',
      payload,
      authToken,
      testnetId: testNetId,
    });
  }

  // Deploy contracts for ganache
  private runDeploy(payload: any, testNetId: string) {
    const deployWorker = this.createWorker();
    deployWorker.on('message', (m: any) => {
      logger.log(`Deploy worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        this._panel.webview.postMessage({ errors: m.error });
      } else {
        this._panel.webview.postMessage({ deployedResult: m });
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    deployWorker.send({
      command: 'deploy-contract',
      payload,
      authToken,
      testnetId: testNetId,
    });
  }

  // sign & deploy unsigned contract transactions
  private signDeployTx(payload: any, testNetId: string) {
    const signedDeployWorker = this.createWorker();
    signedDeployWorker.on('message', (m: any) => {
      logger.log(`SignDeploy worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        this._panel.webview.postMessage({ errors: m.error });
      } else if (m.transactionResult) {
        this._panel.webview.postMessage({
          deployedResult: m.transactionResult,
        });
        this._panel.webview.postMessage({
          transactionResult: m.transactionResult,
        });
        logger.success('Contract transaction submitted!');
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    signedDeployWorker.send({
      command: 'sign-deploy',
      payload,
      authToken,
      testnetId: testNetId,
    });
  }

  // get accounts
  public getAccounts() {
    const accountsWorker = this.createWorker();
    accountsWorker.on('message', (m: any) => {
      logger.log(`Account worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        logger.error(m.error.details);
      }
      this._panel.webview.postMessage({ fetchAccounts: m });
    });
    const authToken = {
      appId: retrieveUserSettings('ethcode.userConfig.appRegistration', 'appId'),
      token: retrieveUserSettings('ethcode.userConfig.appRegistration', 'token'),
    };
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    accountsWorker.send({ command: 'get-accounts', authToken });
  }

  // get local accounts
  private getLocalAccounts(keyStorePath: string) {
    const accWorker = this.createAccWorker();
    accWorker.on('message', (m: any) => {
      logger.log(`Account worker message: ${JSON.stringify(m)}`);
      if (m.localAddresses) {
        this._panel.webview.postMessage({ localAccounts: m.localAddresses });
      }
    });
    accWorker.send({ command: 'get-localAccounts', keyStorePath });
  }

  // get balance of given account
  private getBalance(account: IAccount, testNetId: string) {
    const balanceWorker = this.createWorker();
    balanceWorker.on('message', (m: any) => {
      logger.log(`Balance worker message: ${JSON.stringify(m)}`);
      this._panel.webview.postMessage({ balance: m.balance, account });
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    if (account && Object.keys(account).length > 0)
      balanceWorker.send({
        command: 'get-balance',
        account,
        authToken,
        testnetId: testNetId,
      });
  }

  // call contract method
  private runContractCall(payload: any, testNetId: string) {
    logger.log('Running contract call...');
    const callWorker = this.createWorker();
    callWorker.on('message', (m: any) => {
      logger.log(`Call worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        logger.error(m.error);
        this._panel.webview.postMessage({ errors: m.error });
      } else if (m.unsignedTx) {
        this._panel.webview.postMessage({ unsignedTx: m.unsignedTx });
      } else {
        this._panel.webview.postMessage({ ganacheCallResult: m.callResult });
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    logger.log(`testnet Id: ${testNetId}`);
    if (testNetId === 'ganache') {
      callWorker.send({
        command: 'ganache-contract-method-call',
        payload,
        authToken,
        testnetId: testNetId,
      });
    } else {
      callWorker.send({
        command: 'contract-method-call',
        payload,
        authToken,
        testnetId: testNetId,
      });
    }
  }

  // Get gas estimates
  private runGetGasEstimate(payload: any, testNetId: string) {
    const deployWorker = this.createWorker();
    deployWorker.on('message', (m: any) => {
      logger.log(`Gas worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        logger.error(m.error);
        this._panel.webview.postMessage({ errors: JSON.stringify(m.error) });
      } else {
        this._panel.webview.postMessage({ gasEstimate: m.gasEstimate });
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    deployWorker.send({
      command: 'get-gas-estimate',
      payload,
      authToken,
      testnetId: testNetId,
    });
  }

  // Send ether on ganache
  private sendEther(payload: any, testNetId: string) {
    const sendEtherWorker = this.createWorker();
    sendEtherWorker.on('message', (m: any) => {
      logger.log(`Ether worker message: ${JSON.stringify(m)}`);
      if (m.transactionResult) {
        updateUserSession(m.transactionResult, ['userConfig', 'txHashOfLastSendEther']);
        updateUserSession(testNetId, ['userConfig', 'networkId']);
        this._panel.webview.postMessage({
          transactionResult: m.transactionResult,
        });
        logger.success('Successfully sent Ether');
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    sendEtherWorker.send({
      command: 'send-ether',
      transactionInfo: payload,
      authToken,
      testnetId: testNetId,
    });
  }

  // Send ether using ethereum client
  private sendEtherSigned(payload: any, testNetId: string) {
    const sendEtherWorker = this.createWorker();
    sendEtherWorker.on('message', (m: any) => {
      logger.log(`Ether worker message: ${JSON.stringify(m)}`);
      if (m.unsignedTx) {
        this._panel.webview.postMessage({ unsignedTx: m.unsignedTx });
      } else if (m.transactionResult) {
        updateUserSession(m.transactionResult, ['userConfig', 'txHashOfLastSendEther']);
        updateUserSession(testNetId, ['userConfig', 'networkId']);
        this._panel.webview.postMessage({
          transactionResult: m.transactionResult,
        });
        logger.success('Successfully sent Ether');
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    sendEtherWorker.send({
      command: 'send-ether-signed',
      payload,
      authToken,
      testnetId: testNetId,
    });
  }

  public compileContract(context: ExtensionContext, editorContent: string | undefined, fn: string | undefined) {
    // send JSON serializable compiled data
    const sources: ISources = {};
    if (fn) {
      sources[fn] = {
        content: editorContent,
      };
      context.workspaceState.update('sources', JSON.stringify(sources));
      const regexVyp = /([a-zA-Z0-9\s_\\.\-\\(\\):])+(.vy|.v.py|.vyper.py)$/g;
      const regexSol = /([a-zA-Z0-9\s_\\.\-\\(\\):])+(.sol|.solidity)$/g;
      // @ts-ignore
      if (fn.match(regexVyp) && fn.match(regexVyp).length > 0) {
        // invoke vyper compiler
        this.invokeVyperCompiler(context, sources);
        // @ts-ignore
      } else if (fn.match(regexSol) && fn.match(regexSol).length > 0) {
        // @ts-ignore
        const rootPath = workspace.workspaceFolders[0];
        // invoke solidity compiler
        this.invokeSolidityCompiler(context, sources, rootPath.uri);
      } else {
        const error = new Error('No matching file found!');
        logger.error(error);
        throw error;
      }
    }
  }

  public sendTestContract(editorContent: string | undefined, fn: string | undefined) {
    const sources: ISources = {};
    if (fn) {
      sources[fn] = {
        content: editorContent,
      };
    }
    const solcWorker = this.createWorker();
    this._panel.webview.postMessage({ resetTestState: 'resetTestState' });
    this._panel.webview.postMessage({
      processMessage: 'Running unit tests...',
    });
    solcWorker.send({ command: 'run-test', payload: JSON.stringify(sources) });
    solcWorker.on('message', (m: any) => {
      logger.log(`Remix-tests worker message: ${JSON.stringify(m)}`);
      if (m.data && m.path) {
        sources[m.path] = {
          content: m.data.content,
        };
        solcWorker.send({
          command: 'run-test',
          payload: JSON.stringify(sources),
        });
      }
      if (m.utResp) {
        const res = JSON.parse(m.utResp.result);
        if (res.type) {
          this._panel.webview.postMessage({
            _testCallback: res,
            testPanel: 'test',
          });
        } else {
          this._panel.webview.postMessage({
            _finalCallback: res,
            testPanel: 'test',
          });
          solcWorker.kill();
        }
      }
    });
    solcWorker.on('exit', () => {
      logger.log('Remix-tests worker exited!');
    });
  }

  public getCompilerVersion() {
    return new Promise((resolve, reject) => {
      const versionWorker = this.createWorker();
      versionWorker.send({ command: 'fetch_compiler_version' });
      this._panel.webview.postMessage({
        processMessage: 'Fetching Compiler Versions...',
      });
      versionWorker.on('message', (m: any) => {
        logger.log(`Solidity worker message: ${JSON.stringify(m)}`);
        const { versions } = m;
        if (versions) {
          this._panel.webview.postMessage({ versions });
          this._panel.webview.postMessage({ processMessage: '' });
          resolve(versions);
          versionWorker.kill();
        } else {
          // eslint-disable-next-line prefer-promise-reject-errors
          reject([]);
          versionWorker.kill();
        }
      });
      versionWorker.on('error', (error: Error) => {
        logger.error(error);
        reject(error);
      });
      versionWorker.on('exit', (code: number, signal: string) => {
        const em = `getVersion worker process exited with code ${code} and signal ${signal}`;
        logger.log(em);
        this._panel.webview.postMessage({
          message: `Error code ${code} : Error signal ${signal}`,
        });
        reject(new Error(`Error code ${code} : Error signal ${signal}`));
      });
    });
  }

  public dispose() {
    if (this._disposed) {
      return;
    }
    ReactPanel.currentPanel = undefined;

    // Clean up our resources
    this._panel.dispose();
    this._disposed = true;

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview() {
    // eslint-disable-next-line global-require, import/no-dynamic-require,  @typescript-eslint/no-var-requires
    const manifest = require(path.join(this._extensionPath, 'build', 'asset-manifest.json')).files;
    const mainScript = manifest['main.js'];
    const mainStyle = manifest['main.css'];
    const scriptPathOnDisk = Uri.file(path.join(this._extensionPath, 'build', mainScript));
    const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });
    const stylePathOnDisk = Uri.file(path.join(this._extensionPath, 'build', mainStyle));
    const styleUri = stylePathOnDisk.with({ scheme: 'vscode-resource' });
    // Use a nonce to whitelist which scripts can be run
    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
        <meta name="theme-color" content="#000000">
        <title>ETH code</title>
        <link rel="stylesheet" type="text/css" href="${styleUri}">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}';style-src vscode-resource: 'unsafe-inline' http: https: data:;">
        <base href="${Uri.file(path.join(this._extensionPath, 'build')).with({ scheme: 'vscode-resource' })}/">
      </head>

      <body>
        <noscript>You need to enable JavaScript to run this app.</noscript>
        <div id="root"></div>
        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>`;
  }
}
