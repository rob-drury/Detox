describe('Instrumentation', () => {
  const deviceId = 'mock-device-id';
  const bundleId = 'mock-bundle-id';

  let exec;
  let adb;
  let instrumentationArgs;
  let logger;
  beforeEach(() => {
    const ADB = jest.genMockFromModule('../exec/ADB');
    adb = new ADB();

    jest.mock('../../../../utils/exec');
    exec = require('../../../../utils/exec');

    jest.mock('./instrumentationArgs');
    instrumentationArgs = require('./instrumentationArgs');
    instrumentationArgs.prepareInstrumentationArgs.mockReturnValue({args: [], usedReservedArgs: []});

    logger = {
      warn: jest.fn(),
    }
  });

  let childProcess;
  let instrumentationProcess;
  let logListenCallback;
  let userTerminationCallback;
  let uut;
  beforeEach(() => {
    childProcess = {
      on: jest.fn(),
      stdout: {
        setEncoding: jest.fn(),
        on: jest.fn(),
      },
    };
    instrumentationProcess = {
      childProcess,
    };
    adb.spawnInstrumentation.mockReturnValue(instrumentationProcess);

    logListenCallback = jest.fn();
    userTerminationCallback = jest.fn();

    const Instrumentation = require('./Instrumentation');
    uut = new Instrumentation(adb, logger, userTerminationCallback, logListenCallback);
  });

  it('should spawn Android instrumentation with device ID', async () => {
    await uut.launch(deviceId, bundleId, []);
    expect(adb.spawnInstrumentation).toHaveBeenCalledWith(deviceId, expect.anything(), undefined);
  });

  it('should spawn instrumentation with test runner', async () => {
    const testRunner = 'mock-android-test-runner-name';
    adb.getInstrumentationRunner.mockResolvedValue(testRunner);

    await uut.launch(deviceId, bundleId, []);
    expect(adb.spawnInstrumentation).toHaveBeenCalledWith(expect.anything(), expect.anything(), testRunner);
    expect(adb.getInstrumentationRunner).toHaveBeenCalledWith(deviceId, bundleId);
  });

  describe('spawning launch-arguments processing', () => {
    it('should prepare user launch-arguments', async () => {
      instrumentationArgs.prepareInstrumentationArgs.mockReturnValue({args: [], usedReservedArgs: []});
      const userArgs = {
        arg1: 'value1',
      };
      await uut.launch(deviceId, bundleId, userArgs);

      expect(instrumentationArgs.prepareInstrumentationArgs).toHaveBeenCalledWith(userArgs);
    });

    it('should prepare forced debug=false launch argument', async () => {
      instrumentationArgs.prepareInstrumentationArgs.mockReturnValue({args: [], usedReservedArgs: []});
      await uut.launch(deviceId, bundleId, { });
      expect(instrumentationArgs.prepareInstrumentationArgs).toHaveBeenCalledWith({ debug: false });
    });

    it('should spawn instrumentation with processed user launch-arguments', async () => {
      const mockedPreparedUserArgs = ['mocked', 'prepared-args'];
      const mockedPreparedDebugArg = ['debug', 'mocked'];
      instrumentationArgs.prepareInstrumentationArgs
        .mockReturnValueOnce({ args: mockedPreparedUserArgs, usedReservedArgs: [] })
        .mockReturnValueOnce({ args: mockedPreparedDebugArg, usedReservedArgs: [] });

      await uut.launch(deviceId, bundleId, {});
      expect(adb.spawnInstrumentation).toHaveBeenCalledWith(expect.anything(), [...mockedPreparedUserArgs, ...mockedPreparedDebugArg], undefined);
    });

    it('should log reserved instrumentation args usage if used in user args', async () => {
      const mockedPreparedUserArgs = ['mocked', 'prepared-args'];
      const mockedPreparedDebugArg = ['debug', 'mocked'];
      const usedReservedArgs = ['aaa', 'zzz'];
      instrumentationArgs.prepareInstrumentationArgs
        .mockReturnValueOnce({ args: mockedPreparedUserArgs, usedReservedArgs })
        .mockReturnValueOnce({ args: mockedPreparedDebugArg, usedReservedArgs: ['shouldnt', 'care'] });

      await uut.launch(deviceId, bundleId, {});

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Arguments [aaa,zzz] were passed in as launchArgs to device.launchApp()'));
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('should NOT log reserved instrumentation args usage if none used by user', async () => {
      const mockedPreparedUserArgs = ['mocked', 'prepared-args'];
      const mockedPreparedDebugArg = ['debug', 'mocked'];
      instrumentationArgs.prepareInstrumentationArgs
        .mockReturnValueOnce({ args: mockedPreparedUserArgs, usedReservedArgs: [] })
        .mockReturnValueOnce({ args: mockedPreparedDebugArg, usedReservedArgs: ['shouldnt', 'care'] });

      await uut.launch(deviceId, bundleId, {});

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('instrumentation child-process unplanned termination', () => {
    it('should terminate instrumentation', async () => {
      await uut.launch(deviceId, bundleId, []);

      expect(childProcess.on).toHaveBeenCalledWith('close', expect.any(Function));

      await invokeTerminationCallback();
      expect(exec.interruptProcess).toHaveBeenCalledWith(instrumentationProcess);
    });

    it('should fail if termination callback breaks', async () => {
      exec.interruptProcess.mockRejectedValue(new Error());

      await uut.launch(deviceId, bundleId, []);

      try {
        await invokeTerminationCallback();
        fail();
      } catch(error) {}
    });

    it('should not terminate if dispatched twice', async () => {
      await uut.launch(deviceId, bundleId, []);
      await invokeTerminationCallback();
      await invokeTerminationCallback();
      expect(exec.interruptProcess).toHaveBeenCalledTimes(1);
    });

    it('should exec user\'s top-level custom termination callback', async () => {
      await uut.launch(deviceId, bundleId, []);
      await invokeTerminationCallback();
      expect(userTerminationCallback).toHaveBeenCalled();
    });
  });

  describe('user-initiated termination', () => {
    it('should terminate upon a termination API call', async () => {
      await uut.launch(deviceId, bundleId, []);
      await uut.terminate();
      expect(exec.interruptProcess).toHaveBeenCalledWith(instrumentationProcess);
    });

    it('should break if process interruption fails', async () => {
      exec.interruptProcess.mockRejectedValue(new Error());
      await uut.launch(deviceId, bundleId, []);

      try {
        await uut.terminate();
        fail();
      } catch(error) {}
    });

    it('should not terminate if not running', async () => {
      await uut.terminate();
      expect(exec.interruptProcess).not.toHaveBeenCalled();
    });

    it('should not terminate if already terminated', async () => {
      await uut.launch(deviceId, bundleId, []);
      await uut.terminate();
      await uut.terminate();
      expect(exec.interruptProcess).toHaveBeenCalledTimes(1);
    });

    it('should NOT exec user\'s top-level custom termination callback', async () => {
      await uut.launch(deviceId, bundleId, []);
      await uut.terminate();
      expect(userTerminationCallback).not.toHaveBeenCalled();
    });
  });

  describe('instrumentation run-status querying', () => {
    it('should be true when running', async () => {
      await uut.launch(deviceId, bundleId, []);
      expect(uut.isRunning()).toEqual(true);
    });

    it('should false if terminated', async () => {
      await uut.launch(deviceId, bundleId, []);
      await uut.terminate();
      expect(uut.isRunning()).toEqual(false);
    });
  });

  describe('instrumentation output-log tapping', () => {
    it('should be made possible to tap into, with utf-8 encoding', async () => {
      await uut.launch(deviceId, bundleId, []);
      expect(childProcess.stdout.on).toHaveBeenCalledWith('data', expect.any(Function));
      expect(childProcess.stdout.setEncoding).toHaveBeenCalledWith('utf8');

      await invokeDataCallbackWith('mock data');
      expect(logListenCallback).toHaveBeenCalledWith('mock data');
    });
  });

  it('should allow for runtime setup of termination callback', async () => {
    const runtimeCallback = jest.fn();

    const Instrumentation = require('./Instrumentation');
    uut = new Instrumentation(adb, logger, undefined, undefined);
    uut.setTerminationFn(runtimeCallback);
    await uut.launch(deviceId, bundleId, []);
    await invokeTerminationCallback();

    expect(runtimeCallback).toHaveBeenCalled();
  });

  it('should allow for clearing of termination callback', async () => {
    uut.setTerminationFn(null);
    await uut.launch(deviceId, bundleId, []);
    await uut.terminate();
    expect(userTerminationCallback).not.toHaveBeenCalled();
  });

  it('should allow for runtime setup of log-tapping callback', async () => {
    const runtimeCallback = jest.fn();

    const Instrumentation = require('./Instrumentation');
    uut = new Instrumentation(adb, logger, undefined, undefined);
    await uut.launch(deviceId, bundleId, []);

    uut.setLogListenFn(runtimeCallback);
    await invokeDataCallbackWith('mock data');

    expect(runtimeCallback).toHaveBeenCalledWith('mock data');
  });

  it('should allow for clearing of log-tapping callback', async () => {
    uut.setLogListenFn(null);
    await uut.launch(deviceId, bundleId, []);
    await invokeDataCallbackWith('data');
    expect(logListenCallback).not.toHaveBeenCalled();
  });

  const extractDataCallback = () => childProcess.stdout.on.mock.calls[0][1];
  const invokeDataCallbackWith = async (data) => {
    const fn = extractDataCallback();
    await fn(data);
  }

  const extractTerminationCallback = () => childProcess.on.mock.calls[0][1];
  const invokeTerminationCallback = async () => {
    const terminationFn = extractTerminationCallback();
    await terminationFn();
  }
});