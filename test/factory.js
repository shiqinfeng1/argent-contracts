/* global artifacts */
const ethers = require("ethers");

const BaseWallet = artifacts.require("BaseWallet");
const Module = artifacts.require("TestOnlyOwnerModule");
const ModuleRegistry = artifacts.require("ModuleRegistry");
const ENSRegistry = artifacts.require("ENSRegistry");
const ENSRegistryWithFallback = artifacts.require("ENSRegistryWithFallback");
const ENSManager = artifacts.require("ArgentENSManager");
const ENSResolver = artifacts.require("ArgentENSResolver");
const ENSReverseRegistrar = artifacts.require("ReverseRegistrar");
const Factory = artifacts.require("WalletFactory");
const GuardianStorage = artifacts.require("GuardianStorage");

const utils = require("../utils/utilities.js");

const ZERO_BYTES32 = ethers.constants.HashZero;
const ZERO_ADDRESS = ethers.constants.AddressZero;
const NO_ENS = "";

contract("WalletFactory", (accounts) => {
  const infrastructure = accounts[0];
  const owner = accounts[1];
  const guardian = accounts[4];
  const other = accounts[6];

  const root = "xyz";
  const subnameWallet = "argent";
  const walletNode = ethers.utils.namehash(`${subnameWallet}.${root}`);

  let index = 0;

  let ensRegistry;
  let ensResolver;
  let ensReverse;
  let ensManager;
  let implementation;
  let moduleRegistry;
  let guardianStorage;
  let factory;
  let module1;
  let module2;

  before(async () => {
    const ensRegistryWithoutFallback = await ENSRegistry.new();
    ensRegistry = await ENSRegistryWithFallback.new(ensRegistryWithoutFallback.address);
    ensResolver = await ENSResolver.new();
    ensReverse = await ENSReverseRegistrar.new(ensRegistry.address, ensResolver.address);
    ensManager = await ENSManager.new(`${subnameWallet}.${root}`,
      walletNode, ensRegistry.address, ensResolver.address);
    await ensResolver.addManager(ensManager.address);
    await ensResolver.addManager(infrastructure);
    await ensManager.addManager(infrastructure);

    await ensRegistry.setSubnodeOwner(ZERO_BYTES32, ethers.utils.keccak256(ethers.utils.toUtf8Bytes(root)), infrastructure);
    await ensRegistry.setSubnodeOwner(
      ethers.utils.namehash(root), ethers.utils.keccak256(ethers.utils.toUtf8Bytes(subnameWallet)), ensManager.address,
    );
    await ensRegistry.setSubnodeOwner(ZERO_BYTES32, ethers.utils.keccak256(ethers.utils.toUtf8Bytes("reverse")), infrastructure);
    await ensRegistry.setSubnodeOwner(
      ethers.utils.namehash("reverse"), ethers.utils.keccak256(ethers.utils.toUtf8Bytes("addr")), ensReverse.address,
    );

    implementation = await BaseWallet.new();
    moduleRegistry = await ModuleRegistry.new();
    guardianStorage = await GuardianStorage.new();
    factory = await Factory.new(
      moduleRegistry.address,
      implementation.address,
      ensManager.address,
      guardianStorage.address,
    );
    await factory.addManager(infrastructure);
    await ensManager.addManager(factory.address);
  });

  beforeEach(async () => {
    // Restore the good state of factory (we set these to bad addresses in some tests)
    await factory.changeModuleRegistry(moduleRegistry.address);
    await factory.changeENSManager(ensManager.address);

    module1 = await Module.new(moduleRegistry.address, guardianStorage.address);
    module2 = await Module.new(moduleRegistry.address, guardianStorage.address);
    await moduleRegistry.registerModule(module1.address, ethers.utils.formatBytes32String("module1"));
    await moduleRegistry.registerModule(module2.address, ethers.utils.formatBytes32String("module2"));

    index += 1;
  });

  describe("Create and configure the factory", () => {
    it("should not allow to be created with empty ModuleRegistry", async () => {
      await utils.assertRevert(Factory.new(
        ZERO_ADDRESS,
        implementation.address,
        ensManager.address,
        guardianStorage.address,
      ), "WF: ModuleRegistry address not defined");
    });

    it("should not allow to be created with empty WalletImplementation", async () => {
      await utils.assertRevert(Factory.new(
        moduleRegistry.address,
        ZERO_ADDRESS,
        ensManager.address,
        guardianStorage.address,
      ), "WF: WalletImplementation address not defined");
    });

    it("should not allow to be created with empty ENSManager", async () => {
      await utils.assertRevert(Factory.new(
        moduleRegistry.address,
        implementation.address,
        ZERO_ADDRESS,
        guardianStorage.address,
      ), "WF: ENSManager address not defined");
    });

    it("should not allow to be created with empty GuardianStorage", async () => {
      await utils.assertRevert(Factory.new(
        moduleRegistry.address,
        implementation.address,
        ensManager.address,
        ZERO_ADDRESS,
      ), "WF: GuardianStorage address not defined");
    });

    it("should allow owner to change the module registry", async () => {
      const randomAddress = utils.getRandomAddress();
      await factory.changeModuleRegistry(randomAddress);
      const updatedModuleRegistry = await factory.moduleRegistry();
      assert.equal(updatedModuleRegistry, randomAddress);
    });

    it("should not allow owner to change the module registry to zero address", async () => {
      await utils.assertRevert(factory.changeModuleRegistry(ethers.constants.AddressZero), "WF: address cannot be null");
    });

    it("should not allow non-owner to change the module registry", async () => {
      const randomAddress = utils.getRandomAddress();
      await utils.assertRevert(factory.changeModuleRegistry(randomAddress, { from: other }), "Must be owner");
    });

    it("should allow owner to change the ens manager", async () => {
      const randomAddress = utils.getRandomAddress();
      await factory.changeENSManager(randomAddress);
      const updatedEnsManager = await factory.ensManager();
      assert.equal(updatedEnsManager, randomAddress);
    });

    it("should not allow owner to change the ens manager to a zero address", async () => {
      await utils.assertRevert(factory.changeENSManager(ethers.constants.AddressZero), "WF: address cannot be null");
    });

    it("should not allow non-owner to change the ens manager", async () => {
      const randomAddress = utils.getRandomAddress();
      await utils.assertRevert(factory.changeENSManager(randomAddress, { from: owner }), "Must be owner");
    });

    it("should return the correct ENSManager", async () => {
      const ensManagerOnFactory = await factory.ensManager();
      assert.equal(ensManagerOnFactory, ensManager.address, "should have the correct ENSManager addrress");
    });
  });

  describe("Create wallets with CREATE", () => {
    it("should create with the correct owner", async () => {
      // we create the wallet
      const label = `wallet${index}`;
      const modules = [module1.address];
      const tx = await factory.createWallet(owner, modules, label, guardian);
      const eventArgs = utils.parseLogs(tx.receipt, "WalletCreated");
      const walletAddr = eventArgs.wallet;
      // we test that the wallet has the correct owner
      const wallet = await BaseWallet.at(walletAddr);
      const walletOwner = await wallet.owner();
      assert.equal(walletOwner, owner, "should have the correct owner");
    });

    it("should create with the correct modules", async () => {
      const label = `wallet${index}`;
      const modules = [module1.address, module2.address];
      // we create the wallet
      const tx = await factory.createWallet(owner, modules, label, guardian);
      const eventArgs = utils.parseLogs(tx.receipt, "WalletCreated");
      const walletAddr = eventArgs.wallet;
      // we test that the wallet has the correct modules
      const wallet = await BaseWallet.at(walletAddr);
      let isAuthorised = await wallet.authorised(module1.address);
      assert.equal(isAuthorised, true, "module1 should be authorised");
      isAuthorised = await wallet.authorised(module2.address);
      assert.equal(isAuthorised, true, "module2 should be authorised");
    });

    it("should create with the correct guardian", async () => {
      // we create the wallet
      const label = `wallet${index}`;
      const modules = [module1.address];
      const tx = await factory.createWallet(owner, modules, label, guardian);
      const eventArgs = utils.parseLogs(tx.receipt, "WalletCreated");
      const walletAddr = eventArgs.wallet;
      // we test that the wallet has the correct guardian
      const success = await guardianStorage.isGuardian(walletAddr, guardian);
      assert.equal(success, true, "should have the correct guardian");
    });

    it("should create with the correct ENS name", async () => {
      const label = `wallet${index}`;
      const labelNode = ethers.utils.namehash(`${label}.${subnameWallet}.${root}`);
      const modules = [module1.address, module2.address];
      // we create the wallet
      const tx = await factory.createWallet(owner, modules, label, guardian);
      const eventArgs = utils.parseLogs(tx.receipt, "WalletCreated");
      const walletAddr = eventArgs.wallet;
      // we test that the wallet has the correct ENS
      const nodeOwner = await ensRegistry.owner(labelNode);
      assert.equal(nodeOwner, walletAddr);
      const res = await ensRegistry.resolver(labelNode);
      assert.equal(res, ensResolver.address);
    });

    it("should create when there is no ENS", async () => {
      const modules = [module1.address, module2.address];
      // we create the wallet
      const tx = await factory.createWallet(owner, modules, NO_ENS, guardian);
      const eventArgs = utils.parseLogs(tx.receipt, "WalletCreated");
      const walletAddr = eventArgs.wallet;
      assert.notEqual(walletAddr, ZERO_ADDRESS, "wallet should be created");
    });

    it("should fail to create when the guardian is empty", async () => {
      // we create the wallet
      const label = `wallet${index}`;
      const modules = [module1.address];
      await utils.assertRevert(factory.createWallet(owner, modules, label, ZERO_ADDRESS),
        "WF: guardian cannot be null");
    });

    it("should fail to create when there are no modules", async () => {
      const label = `wallet${index}`;
      const modules = [];
      await utils.assertRevert(factory.createWallet(owner, modules, label, guardian),
        "WF: cannot assign with less than 1 module");
    });

    it("should fail to create with an existing ENS", async () => {
      const label = `wallet${index}`;
      const modules = [module1.address, module2.address];
      await factory.createWallet(owner, modules, label, guardian);
      await utils.assertRevert(factory.createWallet(owner, modules, label, guardian),
        "AEM: _label is alrealdy owned");
    });

    it("should fail to create with zero address as owner", async () => {
      const label = `wallet${index}`;
      const modules = [module1.address];
      await utils.assertRevert(factory.createWallet(ethers.constants.AddressZero, modules, label, guardian),
        "WF: owner cannot be null");
    });

    it("should fail to create with no modules", async () => {
      const label = `wallet${index}`;
      const modules = [];
      await utils.assertRevert(factory.createWallet(owner, modules, label, guardian),
        "WF: cannot assign with less than 1 module");
    });

    it("should fail to create with unregistered module", async () => {
      const label = `wallet${index}`;
      const randomAddress = utils.getRandomAddress();
      const modules = [randomAddress];
      await utils.assertRevert(factory.createWallet(owner, modules, label, guardian),
        "WF: one or more modules are not registered");
    });
  });

  describe("Create wallets with CREATE2", () => {
    beforeEach(async () => {
      module1 = await Module.new(moduleRegistry.address, guardianStorage.address);
      module2 = await Module.new(moduleRegistry.address, guardianStorage.address);
      await moduleRegistry.registerModule(module1.address, ethers.utils.formatBytes32String("module1"));
      await moduleRegistry.registerModule(module2.address, ethers.utils.formatBytes32String("module2"));
    });

    it("should create a wallet at the correct address", async () => {
      const salt = utils.generateSaltValue();
      const label = `wallet${index}`;
      const modules = [module1.address, module2.address];
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, modules, guardian, salt);
      // we create the wallet
      const tx = await factory.createCounterfactualWallet(owner, modules, label, guardian, salt);
      const eventArgs = utils.parseLogs(tx.receipt, "WalletCreated");
      const walletAddr = eventArgs.wallet;
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, walletAddr, "should have the correct address");
    });

    it("should create with the correct owner", async () => {
      const salt = utils.generateSaltValue();
      const label = `wallet${index}`;
      const modules = [module1.address, module2.address];
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, modules, guardian, salt);
      // we create the wallet
      const tx = await factory.createCounterfactualWallet(owner, modules, label, guardian, salt);
      const eventArgs = utils.parseLogs(tx.receipt, "WalletCreated");
      const walletAddr = eventArgs.wallet;
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, walletAddr, "should have the correct address");
      // we test that the wallet has the correct owner
      const wallet = await BaseWallet.at(walletAddr);
      const walletOwner = await wallet.owner();
      assert.equal(walletOwner, owner, "should have the correct owner");
    });

    it("should create with the correct modules", async () => {
      const salt = utils.generateSaltValue();
      const label = `wallet${index}`;
      const modules = [module1.address, module2.address];
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, modules, guardian, salt);
      // we create the wallet
      const tx = await factory.createCounterfactualWallet(owner, modules, label, guardian, salt);
      const eventArgs = utils.parseLogs(tx.receipt, "WalletCreated");
      const walletAddr = eventArgs.wallet;
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, walletAddr, "should have the correct address");
      // we test that the wallet has the correct modules
      const wallet = await BaseWallet.at(walletAddr);
      let isAuthorised = await wallet.authorised(module1.address);
      assert.equal(isAuthorised, true, "module1 should be authorised");
      isAuthorised = await wallet.authorised(module2.address);
      assert.equal(isAuthorised, true, "module2 should be authorised");
    });

    it("should create with the correct ENS name", async () => {
      const salt = utils.generateSaltValue();
      const label = `wallet${index}`;
      const labelNode = ethers.utils.namehash(`${label}.${subnameWallet}.${root}`);
      const modules = [module1.address, module2.address];
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, modules, guardian, salt);
      // we create the wallet
      const tx = await factory.createCounterfactualWallet(owner, modules, label, guardian, salt);
      const eventArgs = utils.parseLogs(tx.receipt, "WalletCreated");
      const walletAddr = eventArgs.wallet;
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, walletAddr, "should have the correct address");
      // we test that the wallet has the correct ENS
      const nodeOwner = await ensRegistry.owner(labelNode);
      assert.equal(nodeOwner, walletAddr);
      const res = await ensRegistry.resolver(labelNode);
      assert.equal(res, ensResolver.address);
    });

    it("should create when there is no ENS", async () => {
      const salt = utils.generateSaltValue();
      const modules = [module1.address, module2.address];
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, modules, guardian, salt);
      // we create the wallet
      const tx = await factory.createCounterfactualWallet(owner, modules, NO_ENS, guardian, salt);
      const eventArgs = utils.parseLogs(tx.receipt, "WalletCreated");
      const walletAddr = eventArgs.wallet;
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, walletAddr, "should have the correct address");
    });

    it("should create with the correct guardian", async () => {
      const salt = utils.generateSaltValue();
      const label = `wallet${index}`;
      const modules = [module1.address, module2.address];
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, modules, guardian, salt);
      // we create the wallet
      const tx = await factory.createCounterfactualWallet(owner, modules, label, guardian, salt);
      const eventArgs = utils.parseLogs(tx.receipt, "WalletCreated");
      const walletAddr = eventArgs.wallet;
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, walletAddr, "should have the correct address");
      // we test that the wallet has the correct guardian
      const success = await guardianStorage.isGuardian(walletAddr, guardian);
      assert.equal(success, true, "should have the correct guardian");
    });

    it("should fail to create a wallet at an existing address", async () => {
      const salt = utils.generateSaltValue();
      const label = `wallet${index}`;
      const modules = [module1.address, module2.address];
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, modules, guardian, salt);
      // we create the first wallet
      const tx = await factory.createCounterfactualWallet(owner, modules, label, guardian, salt);
      const eventArgs = utils.parseLogs(tx.receipt, "WalletCreated");
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, eventArgs.wallet, "should have the correct address");
      // we create the second wallet
      await utils.assertRevert(factory.createCounterfactualWallet(owner, modules, label, guardian, salt));
    });

    it("should fail to create counterfactually when there are no modules (with guardian)", async () => {
      const salt = utils.generateSaltValue();
      const label = `wallet${index}`;
      const modules = [];
      await utils.assertRevert(factory.createCounterfactualWallet(owner, modules, label, guardian, salt),
        "WF: cannot assign with less than 1 module");
    });

    it("should fail to create when the guardian is empty", async () => {
      const salt = utils.generateSaltValue();
      const label = `wallet${index}`;
      const modules = [module1.address, module2.address];
      await utils.assertRevert(factory.createCounterfactualWallet(owner, modules, label, ZERO_ADDRESS, salt),
        "WF: guardian cannot be null");
    });

    it("should emit and event when the balance is non zero at creation", async () => {
      const salt = utils.generateSaltValue();
      const label = `wallet${index}`;
      const modules = [module1.address, module2.address];
      const amount = 10000000000000;
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, modules, guardian, salt);
      // We send ETH to the address
      await web3.eth.sendTransaction({ from: infrastructure, to: futureAddr, value: amount });
      // we create the wallet
      const tx = await factory.createCounterfactualWallet(owner, modules, label, guardian, salt);
      const txReceipt = tx.receipt;

      await utils.hasEvent(txReceipt, "Received");
      const eventArgs = utils.parseLogs(tx.receipt, "Received");
      assert.equal(eventArgs.value.toNumber(), amount, "should log the correct amount");
      assert.equal(eventArgs.sender, "0x0000000000000000000000000000000000000000", "sender should be address(0)");
    });

    it("should fail to get an address when the guardian is empty", async () => {
      const salt = utils.generateSaltValue();
      const modules = [module1.address, module2.address];
      await utils.assertRevert(factory.getAddressForCounterfactualWallet(owner, modules, ZERO_ADDRESS, salt),
        "WF: guardian cannot be null");
    });
  });
});
