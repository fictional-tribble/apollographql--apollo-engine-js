import { ListenOptions as NetListenOptions } from 'net';
import { EventEmitter } from 'events';
import { Server as HttpServer } from 'http';

import { Application as ExpressApp } from 'express';
import { Server as ConnectApp } from 'connect';
import * as KoaApp from 'koa';
import { Server as RestifyServer } from 'restify';

import { EngineConfig, LauncherOptions, ListeningAddress } from './types';
import { ApolloEngineLauncher, joinHostPort } from './launcher';

export interface MeteorListenOptions {
  graphqlPaths?: string[]; // default: ['/graphql']
  innerHost?: string; // default: '127.0.0.1'. This is where Node listens.
  launcherOptions?: LauncherOptions;
}

export interface CoreListenOptions extends MeteorListenOptions {
  port?: number | string;
  host?: string; // default: ''. This is where engineproxy listens.
  pipePath?: string;
}

export interface ListenOptions extends CoreListenOptions {
  httpServer?: HttpServer;
  expressApp?: ExpressApp;
  connectApp?: ConnectApp;
  koaApp?: KoaApp;
  restifyServer?: RestifyServer;
}

export interface EngineNetListenOptions extends NetListenOptions {
  pipePath?: string;
}

export interface HapiListenOptions extends CoreListenOptions {}

// ApolloEngine is the main API used to run engineproxy. It integrates with your
// Node web framework of choice.
export class ApolloEngine extends EventEmitter {
  // Primarily useful if you're having engine listen on 0 for tests.
  public engineListeningAddress: ListeningAddress;

  private config: EngineConfig;
  private launcher: ApolloEngineLauncher;
  private httpServer: HttpServer | null;

  // The constructor takes the underlying engineproxy config file. All options
  // specific to the Node API are passed to `listen` (or other entry point) to
  // maintain a strict separate between Node options and engineproxy config.
  public constructor(config: EngineConfig = {}) {
    super();
    this.config = config;
    this.launcher = new ApolloEngineLauncher(config);
    this.httpServer = null;
  }

  // listen tells your app to listen on an ephemeral port, then starts an
  // engineproxy listening on the specified port configured with your app's
  // ephemeral port as an origin.
  public listen(options: ListenOptions, listenCallback?: () => void) {
    if (options.port === undefined && options.pipePath === undefined) {
      throw new Error(
        'Must provide either the `pipePath` or the `port` that your app will be accessible on.',
      );
    }
    let httpServer: HttpServer;
    let appsProvided = 0;
    if (options.httpServer) {
      httpServer = options.httpServer;
      appsProvided++;
    }
    if (options.expressApp) {
      httpServer = new HttpServer(options.expressApp);
      appsProvided++;
    }
    if (options.connectApp) {
      httpServer = new HttpServer(options.connectApp);
      appsProvided++;
    }
    if (options.koaApp) {
      httpServer = new HttpServer(options.koaApp.callback());
      appsProvided++;
    }
    if (options.restifyServer) {
      httpServer = options.restifyServer.server;
      appsProvided++;
    }

    if (appsProvided === 0) {
      throw new Error(
        'Must provide "httpServer", "expressApp", "connectApp", "koaApp", or "restifyServer"',
      );
    }
    if (appsProvided > 1) {
      throw new Error(
        'Must only provide one of "httpServer", "expressApp", "connectApp", "koaApp", and "restifyServer"',
      );
    }
    this.httpServer = httpServer!;
    // Note: if the listen fails, then httpServer will emit an error, and
    // there's no way for our user to catch it. However, this is exactly the
    // same situation as express/koa/connect's listen() method, so that's OK; if
    // the user wants to listen for that error they can spend one line turning
    // their app into an http.Server and pass that in instead.
    // (And with restify, they have access to restifyServer.server themselves.)
    this.httpServer.listen(
      { port: 0, host: options.innerHost || '127.0.0.1' },
      () => {
        // The Node server is now listening, so we can figure out what its address
        // is!
        //
        // We run listenCallback and this.emit('error') outside of this Promise's
        // then/catch, because we want to avoid making `listen` a Promisey API
        // (because we want it to work like httpServer.listen), and doing stuff
        // that can throw in a then/catch means that we would need somebody to be
        // catch-ing the Promise itself.
        this.startEngine(httpServer.address(), options)
          .then(() => listenCallback && process.nextTick(listenCallback))
          .catch(error => {
            process.nextTick(() => this.emit('error', error));
          });
      },
    );
  }

  // Stops Engine and your app.
  public async stop() {
    await this.launcher.stop();
    // XXX Should we also wait for all current connections to be closed?
    this.httpServer!.close();
    this.httpServer = null;
  }

  // Call this from the top level of a Meteor server as
  // `engine.meteorListen(WebApp)` to hook in to the built-in connect server.
  public meteorListen(webApp: any, options: MeteorListenOptions = {}) {
    const makeListenPolyfill = (httpServer: HttpServer) => (
      listenOptions: EngineNetListenOptions,
      cb: () => void,
    ) => {
      let engineListenOptions;
      if (listenOptions.path !== undefined) {
        throw Error('Engine does not support listening on a path');
      }
      if (listenOptions.port === undefined) {
        if (!listenOptions.pipePath) {
          throw Error('Engine needs a port or a pipe name to listen on');
        }
        engineListenOptions = {
          pipePath: listenOptions.pipePath,
        };
      } else {
        engineListenOptions = {
          port: listenOptions.port,
          host: listenOptions.host,
        };
      }
      this.listen(
        {
          ...options,
          ...engineListenOptions,
          httpServer,
        },
        cb,
      );
    };

    // Try to use an API to be added in Meteor 1.6.2 that lets us override the
    // built-in listen call.
    if (webApp.startListening) {
      webApp.startListening = (
        httpServer: HttpServer,
        listenOptions: EngineNetListenOptions,
        cb: () => void,
      ) => {
        makeListenPolyfill(httpServer)(listenOptions, cb);
      };
      return;
    }

    // Hacky pre-1.6.2 approach.
    const originalListen = webApp.httpServer.listen;
    const listenPolyfill = makeListenPolyfill(webApp.httpServer);
    webApp.httpServer.listen = (
      listenOptions: EngineNetListenOptions,
      cb: () => void,
    ) => {
      webApp.httpServer.listen = originalListen;
      listenPolyfill(listenOptions, cb);
    };
  }

  // Pass this as `listener` to hapi.Server's constructor along with
  // `autoListen: false` to hopefully integrate with hapi.
  public async hapiListener(options: HapiListenOptions) {
    const httpServer = new HttpServer();
    const p = new Promise((resolve, reject) => {
      this.once('error', reject);
      this.listen({ ...options, httpServer }, resolve);
    });
    await p;

    // The autoListen:false feature of hapi is semi-broken: some key
    // functionality depends on the 'listening' event being evoked even if you
    // told it it's already listening. Here's a fun hack to make sure we call it
    // anyway!
    function callListeningImmediately(event: String, listening: Function) {
      if (event !== 'listening') {
        return;
      }
      httpServer.removeListener('newListener', callListeningImmediately);
      process.nextTick(() => httpServer.emit('listening'));
    }
    httpServer.on('newListener', callListeningImmediately);
    return httpServer;
  }

  private async startEngine(
    innerAddress: { port: number; address: string },
    options: CoreListenOptions,
  ) {
    if (options.port === undefined && options.pipePath === undefined) {
      throw new Error('Either `port` or `pipePath` must be defined');
    } else if (typeof options.port === 'string') {
      const stringPort = options.port;
      options.port = parseInt(stringPort, 10);
      if (isNaN(options.port)) {
        // Engine only knows how to listen on Windows named pipes
        const winPipePrefix = String.raw`\\.\pipe`;
        if (stringPort.startsWith(winPipePrefix + '\\')) {
          options.pipePath = stringPort;
          options.port = undefined;
        } else {
          throw new Error(
            'port must be an integer or a Windows named pipe, ' +
              `not '${stringPort}'`,
          );
        }
      }
    }
    if (options.pipePath !== undefined && options.port !== undefined) {
      throw new Error('Only one of `port `and `pipePath` may be set');
    }
    const defaults = {
      frontendHost: options.host,
      frontendPort: options.port || undefined,
      frontendPipePath: options.pipePath || undefined,
      graphqlPaths: options.graphqlPaths || ['/graphql'],
      originUrl: `http://${joinHostPort(
        innerAddress.address,
        innerAddress.port,
      )}`,
      // Support multiple graphqlPaths.
      useFrontendPathForDefaultOrigin: true,
    };

    const launcherOptions = Object.assign({}, options.launcherOptions);
    launcherOptions.extraArgs = [
      ...(launcherOptions.extraArgs || []),
      `-defaults=${JSON.stringify(defaults)}`,
    ];

    this.engineListeningAddress = await this.launcher.start(launcherOptions);
  }
}
