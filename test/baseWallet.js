/* global artifacts */
const ethers = require("ethers");

const Proxy = artifacts.require("Proxy");
const BaseWallet = artifacts.require("BaseWallet");
const OldWalletV16 = require("../build-legacy/v1.6.0/BaseWallet");
const OldWalletV13 = require("../build-legacy/v1.3.0/BaseWallet");

const TestModule = artifacts.require("TestModule");
const Registry = artifacts.require("ModuleRegistry");
const SimpleUpgrader = artifacts.require("SimpleUpgrader");
const GuardianStorage = artifacts.require("GuardianStorage");

const { getBalance } = require("../utils/utilities.js");

contract("BaseWallet", (accounts) => {
  const owner = accounts[1];
  const nonowner = accounts[2];

  let wallet;
  let walletImplementation;
  let registry;
  let module1;
  let module2;
  let module3;
  let guardianStorage;

  before(async () => {
    registry = await Registry.new();
    guardianStorage = await GuardianStorage.new();
    module1 = await TestModule.new(registry.address, guardianStorage.address, true, 42);
    module2 = await TestModule.new(registry.address, guardianStorage.address, false, 42);
    module3 = await TestModule.new(registry.address, guardianStorage.address, true, 42);
    walletImplementation = await BaseWallet.new();
  });

  beforeEach(async () => {
    const proxy = await Proxy.new(walletImplementation.address);
    wallet = BaseWallet.at(proxy.address);
  });

  describe("Registering modules", () => {
    it("should register a module with the correct info", async () => {
      const name = ethers.utils.formatBytes32String("module1");
      await registry.registerModule(module1.address, name);
      const isRegistered = await registry["isRegisteredModule(address)"](module1.address);
      assert.isTrue(isRegistered, "module should be registered");
      const info = await registry.moduleInfo(module1.address);
      assert.equal(name, info, "name should be correct");
    });

    it("should deregister a module", async () => {
      const name = ethers.utils.formatBytes32String("module2");
      await registry.registerModule(module2.address, name);
      let isRegistered = await registry["isRegisteredModule(address)"](module2.address);
      assert.isTrue(isRegistered, "module should be registered");
      await registry.deregisterModule(module2.address);
      isRegistered = await registry["isRegisteredModule(address)"](module2.address);
      assert.isFalse(isRegistered, "module should be deregistered");
    });

    it("should register an upgrader with the correct info", async () => {
      const name = ethers.utils.formatBytes32String("upgrader1");
      await registry.registerUpgrader(module1.address, name);
      const isRegistered = await registry.isRegisteredUpgrader(module1.address);
      assert.isTrue(isRegistered, "module should be registered");
      const info = await registry.upgraderInfo(module1.address);
      assert.equal(name, info, "name should be correct");
    });

    it("should deregister an upgrader", async () => {
      const name = ethers.utils.formatBytes32String("upgrader2");
      await registry.registerUpgrader(module2.address, name);
      let isRegistered = await registry.isRegisteredUpgrader(module2.address);
      assert.isTrue(isRegistered, "upgrader should be registered");
      await registry.deregisterUpgrader(module2.address);
      isRegistered = await registry.isRegisteredUpgrader(module2.address);
      assert.isFalse(isRegistered, "upgrader should be deregistered");
    });
  });

  describe("Initialize Wallets", () => {
    describe("wallet init", () => {
      it("should create a wallet with the correct owner", async () => {
        let walletOwner = await wallet.owner();
        assert.equal(walletOwner, "0x0000000000000000000000000000000000000000", "owner should be null before init");
        await wallet.init(owner, [module1.address]);
        walletOwner = await wallet.owner();
        assert.equal(walletOwner, owner, "owner should be the owner after init");
      });

      it("should create a wallet with the correct modules", async () => {
        await wallet.init(owner, [module1.address, module2.address]);
        const module1IsAuthorised = await wallet.authorised(module1.address);
        const module2IsAuthorised = await wallet.authorised(module2.address);
        const module3IsAuthorised = await wallet.authorised(module3.address);
        assert.equal(module1IsAuthorised, true, "module1 should be authorised");
        assert.equal(module2IsAuthorised, true, "module2 should be authorised");
        assert.equal(module3IsAuthorised, false, "module3 should not be authorised");
      });

      it("should not reinitialize a wallet", async () => {
        await wallet.init(owner, [module1.address]);
        await assert.revertWith(wallet.init(owner, [module1.address]), "BW: wallet already initialised");
      });

      it("should not initialize a wallet with no module", async () => {
        await assert.revertWith(wallet.init(owner, []), "BW: construction requires at least 1 module");
      });

      it("should not initialize a wallet with duplicate modules", async () => {
        await assert.revertWith(wallet.init(owner, [module1.address, module1.address]), "BW: module is already added");
      });
    });

    describe("Receiving ETH", () => {
      it("should accept ETH", async () => {
        const before = await getBalance(wallet.address);
        await wallet.send(50000000);
        const after = await getBalance(wallet.address);
        assert.equal(after.sub(before).toNumber(), 50000000, "should have received ETH");
      });

      it("should accept ETH with data", async () => {
        const before = await getBalance(wallet.address);
        await wallet.send(50000000, { data: 0x1234 });
        const after = await getBalance(wallet.address);
        assert.equal(after.sub(before).toNumber(), 50000000, "should have received ETH");
      });
    });

    describe("Authorisations", () => {
      it("should not let a non-module deauthorise a module", async () => {
        await wallet.init(owner, [module1.address]);
        await assert.revertWith(wallet.authoriseModule(module1.address, false), "BW: msg.sender not an authorized module");
      });

      it("should not let a module set the owner to address(0)", async () => {
        await wallet.init(owner, [module1.address]);
        await assert.revertWith(module1.invalidOwnerChange(wallet.address), "BW: address cannot be null");
      });
    });

    describe("Static calls", () => {
      it("should delegate static calls to the modules", async () => {
        await wallet.init(owner, [module1.address]);
        const module1IsAuthorised = await wallet.authorised(module1.address);
        assert.equal(module1IsAuthorised, true, "module1 should be authorised");
        const walletAsModule = await TestModule.at(wallet.address);
        const boolVal = await walletAsModule.contract.getBoolean();
        const uintVal = await walletAsModule.contract.getUint();
        const addressVal = await walletAsModule.contract.getAddress(nonowner);
        assert.equal(boolVal, true, "should have the correct bool");
        assert.equal(uintVal, 42, "should have the correct uint");
        assert.equal(addressVal, nonowner, "should have the address");
      });

      it("should not delegate static calls to unauthorised modules ", async () => {
        await wallet.init(owner, [module1.address]);
        const module1IsAuthorised = await wallet.authorised(module1.address);
        assert.equal(module1IsAuthorised, true, "module1 should be authorised");
        const module2IsAuthorised = await wallet.authorised(module2.address);
        assert.equal(module2IsAuthorised, false, "module2 should not be authorised");
        await assert.revertWith(module1.enableStaticCalls(wallet.address, module2.address),
          "BW: must be an authorised module for static call");
      });

      it("should not delegate static calls to no longer authorised modules ", async () => {
        await wallet.init(owner, [module2.address, module1.address]);
        let module1IsAuthorised = await wallet.authorised(module1.address);
        assert.equal(module1IsAuthorised, true, "module1 should be authorised");

        // removing module 1
        const upgrader = await SimpleUpgrader.new(registry.address, [module1.address], []);
        await registry.registerModule(upgrader.address, ethers.utils.formatBytes32String("Removing module1"));
        await module1.addModule(wallet.address, upgrader.address, { from: owner });
        module1IsAuthorised = await wallet.authorised(module1.address);
        assert.equal(module1IsAuthorised, false, "module1 should not be authorised");

        // trying to execute static call delegated to module1 (it should fail)
        const walletAsModule = await TestModule.at(wallet.address);
        await assert.revertWith(walletAsModule.contract.getBoolean(), "BW: must be an authorised module for static call");
      });
    });
  });

  describe("Old BaseWallet V1.3", () => {
    it("should work with new modules", async () => {
      const oldWallet = await OldWalletV13.new();
      await oldWallet.init(owner, [module1.address]);
      await module1.callDapp(oldWallet.address);
      await module1.callDapp2(oldWallet.address, 2, false);
      await assert.revert(module1.fail(oldWallet.address, "just because"));
    });
  });

  describe("Old BaseWallet V1.6", () => {
    it("should work with new modules", async () => {
      const oldWallet = await OldWalletV16.new();
      await oldWallet.init(owner, [module1.address]);
      await module1.callDapp(oldWallet.address);
      await module1.callDapp2(oldWallet.address, 2, true);
      await assert.revert(module1.fail(oldWallet.address, "just because"));
    });
  });
});
