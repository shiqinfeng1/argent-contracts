/* global artifacts */
const ethers = require("ethers");

const GuardianManager = artifacts.require("GuardianManager");
const GuardianStorage = artifacts.require("GuardianStorage");
const Proxy = artifacts.require("Proxy");
const BaseWallet = artifacts.require("BaseWallet");
const RelayerModule = artifacts.require("RelayerModule");
const Registry = artifacts.require("ModuleRegistry");
const DumbContract = artifacts.require("TestContract");
const NonCompliantGuardian = artifacts.require("NonCompliantGuardian");

const TestManager = require("../utils/test-manager");

contract("GuardianManager", (accounts) => {
  const manager = new TestManager(accounts);

  const owner = accounts[1];
  const guardian1 = accounts[2];
  const guardian2 = accounts[3];
  const guardian3 = accounts[4];
  const guardian4 = accounts[5];
  const guardian5 = accounts[6];
  const nonowner = accounts[7];

  let deployer;
  let wallet;
  let walletImplementation;
  let guardianStorage;
  let guardianManager;
  let relayerModule;

  before(async () => {
    deployer = manager.newDeployer();
    walletImplementation = await deployer.deploy(BaseWallet);
  });

  beforeEach(async () => {
    const registry = await deployer.deploy(Registry);
    guardianStorage = await deployer.deploy(GuardianStorage);
    relayerModule = await deployer.deploy(RelayerModule, {},
      registry.contractAddress,
      guardianStorage.contractAddress,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero);
    manager.setRelayerModule(relayerModule);
    guardianManager = await deployer.deploy(GuardianManager, {}, registry.contractAddress, guardianStorage.contractAddress, 24, 12);
    const proxy = await deployer.deploy(Proxy, {}, walletImplementation.contractAddress);
    wallet = deployer.wrapDeployedContract(BaseWallet, proxy.contractAddress);
    await wallet.init(owner, [guardianManager.contractAddress, relayerModule.contractAddress]);
  });

  describe("Adding Guardians", () => {
    describe("EOA Guardians", () => {
      it("should let the owner add EOA Guardians (blockchain transaction)", async () => {
        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian1);
        let count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
        let active = await guardianManager.isGuardian(wallet.contractAddress, guardian1);
        assert.isTrue(active, "first guardian should be active");
        assert.equal(count, 1, "1 guardian should be active");

        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian2);
        count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
        active = await guardianManager.isGuardian(wallet.contractAddress, guardian2);
        assert.isFalse(active, "second guardian should not yet be active");
        assert.equal(count, 1, "second guardian should be pending during security period");

        await manager.increaseTime(30);
        await guardianManager.confirmGuardianAddition(wallet.contractAddress, guardian2);
        count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
        active = await guardianManager.isGuardian(wallet.contractAddress, guardian2);
        assert.isTrue(active, "second guardian should be active");
        assert.equal(count, 2, "2 guardians should be active after security period");
      });

      it("should not let the owner add EOA Guardians after two security periods (blockchain transaction)", async () => {
        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian1);
        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian2);

        await manager.increaseTime(48); // 42 == 2 * security_period
        await assert.revertWith(guardianManager.confirmGuardianAddition(wallet.contractAddress, guardian2),
          "GM: Too late to confirm guardian addition");

        const count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
        const active = await guardianManager.isGuardian(wallet.contractAddress, guardian2);
        assert.isFalse(active, "second guardian should not be active (addition confirmation was too late)");
        assert.equal(count, 1, "1 guardian should be active after two security periods (addition confirmation was too late)");
      });

      it("should not allow confirming too early", async () => {
        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian1);
        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian2);
        await assert.revertWith(guardianManager.confirmGuardianAddition(wallet.contractAddress, guardian2),
          "GM: Too early to confirm guardian addition");
      });

      it("should let the owner re-add EOA Guardians after missing the confirmation window (blockchain transaction)", async () => {
        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian1);

        // first time
        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian2);

        await manager.increaseTime(48); // 42 == 2 * security_period
        await assert.revertWith(guardianManager.confirmGuardianAddition(wallet.contractAddress, guardian2),
          "GM: Too late to confirm guardian addition");

        // second time
        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian2);
        let count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
        let active = await guardianManager.isGuardian(wallet.contractAddress, guardian2);
        assert.isFalse(active, "second guardian should not yet be active");
        assert.equal(count, 1, "second guardian should be pending during security period");

        await manager.increaseTime(30);
        await guardianManager.confirmGuardianAddition(wallet.contractAddress, guardian2);
        count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
        active = await guardianManager.isGuardian(wallet.contractAddress, guardian2);
        assert.isTrue(active, "second guardian should be active");
        assert.equal(count, 2, "2 guardians should be active after security period");
      });

      it("should only let the owner add an EOA guardian", async () => {
        await assert.revertWith(guardianManager.from(nonowner).addGuardian(wallet.contractAddress, guardian1),
          "BM: must be owner or module");
      });

      it("should not allow adding wallet owner as guardian", async () => {
        await assert.revertWith(guardianManager.from(owner).addGuardian(wallet.contractAddress, owner),
          "GM: target guardian cannot be owner");
      });

      it("should not allow adding an existing guardian twice", async () => {
        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian1);
        await assert.revertWith(guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian1),
          "GM: target is already a guardian");
      });

      it("should not allow adding a duplicate request to add a guardian to the request queue", async () => {
        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian1);
        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian2);
        await assert.revertWith(guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian2),
          "GM: addition of target as guardian is already pending");
      });

      it("should let the owner add an EOA guardian (relayed transaction)", async () => {
        await manager.relay(guardianManager, "addGuardian", [wallet.contractAddress, guardian1], wallet, [owner]);
        const count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
        const active = await guardianManager.isGuardian(wallet.contractAddress, guardian1);
        assert.isTrue(active, "first guardian should be active");
        assert.equal(count, 1, "1 guardian should be active");
      });

      it("should add many Guardians (blockchain transaction)", async () => {
        const guardians = [guardian1, guardian2, guardian3, guardian4, guardian5];
        let count;
        let active;
        for (let i = 1; i <= 5; i += 1) {
          await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardians[i - 1]);
          if (i > 1) {
            await manager.increaseTime(31);
            await guardianManager.confirmGuardianAddition(wallet.contractAddress, guardians[i - 1]);
          }
          count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
          active = await guardianManager.isGuardian(wallet.contractAddress, guardians[i - 1]);
          assert.equal(count, i, `guardian ${i} should be added`);
          assert.isTrue(active, `guardian ${i} should be active`);
        }
      });

      it("should add many Guardians (relayed transaction)", async () => {
        const guardians = [guardian1, guardian2, guardian3, guardian4, guardian5];
        let count;
        let active;
        for (let i = 1; i <= 3; i += 1) {
          await manager.relay(guardianManager, "addGuardian", [wallet.contractAddress, guardians[i - 1]], wallet, [owner]);
          if (i > 1) {
            await manager.increaseTime(30);
            await manager.relay(guardianManager, "confirmGuardianAddition", [wallet.contractAddress, guardians[i - 1]], wallet, []);
          }
          count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
          active = await guardianManager.isGuardian(wallet.contractAddress, guardians[i - 1]);
          assert.equal(count, i, `guardian ${i} should be added`);
          assert.isTrue(active, `guardian ${i} should be active`);
        }
      });
    });

    describe("Smart Contract Guardians", () => {
      let guardianWallet1;
      let guardianWallet2;
      let dumbContract;

      beforeEach(async () => {
        const proxy1 = await deployer.deploy(Proxy, {}, walletImplementation.contractAddress);
        guardianWallet1 = deployer.wrapDeployedContract(BaseWallet, proxy1.contractAddress);
        await guardianWallet1.init(guardian1, [guardianManager.contractAddress]);

        const proxy2 = await deployer.deploy(Proxy, {}, walletImplementation.contractAddress);
        guardianWallet2 = deployer.wrapDeployedContract(BaseWallet, proxy2.contractAddress);
        await guardianWallet2.init(guardian2, [guardianManager.contractAddress]);
        dumbContract = await deployer.deploy(DumbContract);
      });

      it("should let the owner add Smart Contract Guardians (blockchain transaction)", async () => {
        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardianWallet1.contractAddress);
        let count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
        let active = await guardianManager.isGuardian(wallet.contractAddress, guardian1);
        assert.isTrue(active, "first guardian owner should be recognized as guardian");
        active = await guardianManager.isGuardian(wallet.contractAddress, guardianWallet1.contractAddress);
        assert.isTrue(active, "first guardian should be recognized as guardian");
        assert.equal(count, 1, "1 guardian should be active");

        await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardianWallet2.contractAddress);
        count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
        active = await guardianManager.isGuardian(wallet.contractAddress, guardian2);
        assert.isFalse(active, "second guardian owner should not yet be active");
        active = await guardianManager.isGuardian(wallet.contractAddress, guardianWallet2.contractAddress);
        assert.isFalse(active, "second guardian should not yet be active");
        assert.equal(count, 1, "second guardian should be pending during security period");

        await manager.increaseTime(30);
        await guardianManager.confirmGuardianAddition(wallet.contractAddress, guardianWallet2.contractAddress);
        count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
        active = await guardianManager.isGuardian(wallet.contractAddress, guardian2);
        assert.isTrue(active, "second guardian owner should be active");
        active = await guardianManager.isGuardian(wallet.contractAddress, guardianWallet2.contractAddress);
        assert.isTrue(active, "second guardian should be active");
        assert.equal(count, 2, "2 guardians should be active after security period");
      });

      it("should let the owner add a Smart Contract guardian (relayed transaction)", async () => {
        await manager.relay(guardianManager, "addGuardian", [wallet.contractAddress, guardianWallet1.contractAddress], wallet, [owner]);
        const count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
        let active = await guardianManager.isGuardian(wallet.contractAddress, guardianWallet1.contractAddress);
        assert.isTrue(active, "first guardian should be active");
        active = await guardianManager.isGuardian(wallet.contractAddress, guardian1);
        assert.isTrue(active, "first guardian owner should be active");
        assert.equal(count, 1, "1 guardian should be active");
      });

      it("should not let owner add a Smart Contract guardian that does not have an owner manager", async () => {
        await assert.revertWith(guardianManager.from(owner).addGuardian(wallet.contractAddress, dumbContract.contractAddress),
          "GM: guardian must be EOA or implement owner()");
      });

      describe("Non-Compliant Guardians", () => {
        let nonCompliantGuardian;
        beforeEach(async () => {
          await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian1);
          nonCompliantGuardian = await deployer.deploy(NonCompliantGuardian);
        });
        it("it should fail to add a non-compliant guardian", async () => {
          await assert.revert(guardianManager.from(owner).addGuardian(wallet.contractAddress, nonCompliantGuardian.contractAddress));
        });
      });
    });
  });

  describe("Revoking Guardians", () => {
    beforeEach(async () => {
      await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian1);
      await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian2);
      await manager.increaseTime(30);
      await guardianManager.confirmGuardianAddition(wallet.contractAddress, guardian2);
      const count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 2, "2 guardians should be added");
    });

    it("should revoke a guardian (blockchain transaction)", async () => {
      await guardianManager.from(owner).revokeGuardian(wallet.contractAddress, guardian1);
      let count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
      let active = await guardianManager.isGuardian(wallet.contractAddress, guardian1);
      assert.isTrue(active, "the revoked guardian should still be active during the security period");
      assert.equal(count, 2, "the revoked guardian should go through a security period");

      await manager.increaseTime(30);
      await guardianManager.confirmGuardianRevokation(wallet.contractAddress, guardian1);
      count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
      active = await guardianManager.isGuardian(wallet.contractAddress, guardian1);
      assert.isFalse(active, "the revoked guardian should no longer be active after the security period");
      assert.equal(count, 1, "the revoked guardian should be removed after the security period");
    });

    it("should not be able to revoke a nonexistent guardian", async () => {
      await assert.revertWith(guardianManager.from(owner).revokeGuardian(wallet.contractAddress, nonowner),
        "GM: must be an existing guardian");
    });

    it("should not confirm a guardian revokation too early", async () => {
      await guardianManager.from(owner).revokeGuardian(wallet.contractAddress, guardian1);
      await assert.revertWith(guardianManager.confirmGuardianRevokation(wallet.contractAddress, guardian1),
        "GM: Too early to confirm guardian revokation");
    });

    it("should not confirm a guardian revokation after two security periods (blockchain transaction)", async () => {
      await guardianManager.from(owner).revokeGuardian(wallet.contractAddress, guardian1);

      await manager.increaseTime(48); // 48 == 2 * security_period
      await assert.revertWith(guardianManager.confirmGuardianRevokation(wallet.contractAddress, guardian1),
        "GM: Too late to confirm guardian revokation");
    });

    it("should not be able to revoke a guardian twice", async () => {
      await guardianManager.from(owner).revokeGuardian(wallet.contractAddress, guardian1);
      await assert.revertWith(guardianManager.from(owner).revokeGuardian(wallet.contractAddress, guardian1),
        "GM: revokation of target as guardian is already pending");
    });

    it("should revoke a guardian again after missing the confirmation window the first time (blockchain transaction)", async () => {
      // first time
      await guardianManager.from(owner).revokeGuardian(wallet.contractAddress, guardian1);

      await manager.increaseTime(48); // 48 == 2 * security_period
      await assert.revertWith(guardianManager.confirmGuardianRevokation(wallet.contractAddress, guardian1),
        "GM: Too late to confirm guardian revokation");

      // second time
      await guardianManager.from(owner).revokeGuardian(wallet.contractAddress, guardian1);
      let count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
      let active = await guardianManager.isGuardian(wallet.contractAddress, guardian1);
      assert.isTrue(active, "the revoked guardian should still be active during the security period");
      assert.equal(count, 2, "the revoked guardian should go through a security period");

      await manager.increaseTime(30);
      await guardianManager.confirmGuardianRevokation(wallet.contractAddress, guardian1);
      count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
      active = await guardianManager.isGuardian(wallet.contractAddress, guardian1);
      assert.isFalse(active, "the revoked guardian should no longer be active after the security period");
      assert.equal(count, 1, "the revoked guardian should be removed after the security period");
    });

    it("should add a guardian after a revoke (blockchain transaction)", async () => {
      await guardianManager.from(owner).revokeGuardian(wallet.contractAddress, guardian1);
      await manager.increaseTime(30);
      await guardianManager.confirmGuardianRevokation(wallet.contractAddress, guardian1);
      let count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 1, "there should be 1 guardian left");

      await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian3);
      await manager.increaseTime(30);
      await guardianManager.confirmGuardianAddition(wallet.contractAddress, guardian3);
      count = (await guardianStorage.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 2, "there should be 2 guardians again");
    });

    it("should be able to remove a guardian that is the last in the list", async () => {
      await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian3);
      await manager.increaseTime(30);
      await guardianManager.confirmGuardianAddition(wallet.contractAddress, guardian3);
      let count = await guardianStorage.guardianCount(wallet.contractAddress);
      assert.equal(count.toNumber(), 3, "there should be 3 guardians");

      const guardians = await guardianStorage.getGuardians(wallet.contractAddress);
      await guardianManager.from(owner).revokeGuardian(wallet.contractAddress, guardians[2]);
      await manager.increaseTime(30);
      await guardianManager.confirmGuardianRevokation(wallet.contractAddress, guardians[2]);
      count = await guardianStorage.guardianCount(wallet.contractAddress);
      assert.equal(count.toNumber(), 2, "there should be 2 guardians left");
    });
  });

  describe("Cancelling Pending Guardians", () => {
    beforeEach(async () => {
      await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian1);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 1, "1 guardian should be added");
    });

    it("owner should be able to cancel pending addition of guardian (blockchain transaction)", async () => {
      // Add guardian 2 and cancel its addition
      await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian2);
      await guardianManager.from(owner).cancelGuardianAddition(wallet.contractAddress, guardian2);
      await manager.increaseTime(30);
      await assert.revertWith(guardianManager.confirmGuardianAddition(wallet.contractAddress, guardian2),
        "GM: no pending addition as guardian for target");
    });

    it("owner should not be able to cancel a nonexistent addition of a guardian request", async () => {
      await assert.revertWith(guardianManager.from(owner).cancelGuardianAddition(wallet.contractAddress, guardian2),
        "GM: no pending addition as guardian for target");
    });

    it("owner should be able to cancel pending revokation of guardian (blockchain transaction)", async () => {
      // Revoke guardian 1 and cancel its revokation
      await guardianManager.from(owner).revokeGuardian(wallet.contractAddress, guardian1);
      await guardianManager.from(owner).cancelGuardianRevokation(wallet.contractAddress, guardian1);
      await manager.increaseTime(30);
      await assert.revertWith(guardianManager.confirmGuardianRevokation(wallet.contractAddress, guardian1),
        "GM: no pending guardian revokation for target");
    });

    it("owner should not be able to cancel a nonexistent pending revokation of guardian", async () => {
      await assert.revertWith(guardianManager.from(owner).cancelGuardianRevokation(wallet.contractAddress, nonowner),
        "GM: no pending guardian revokation for target");
    });

    it("owner should be able to cancel pending addition of guardian (relayed transaction)", async () => {
      // Add guardian 2 and cancel its addition
      await manager.relay(guardianManager, "addGuardian", [wallet.contractAddress, guardian2], wallet, [owner]);
      await manager.relay(guardianManager, "cancelGuardianAddition", [wallet.contractAddress, guardian2], wallet, [owner]);
      await manager.increaseTime(30);
      await assert.revertWith(guardianManager.confirmGuardianAddition(wallet.contractAddress, guardian2),
        "GM: no pending addition as guardian for target");
    });

    it("owner should be able to cancel pending revokation of guardian (relayed transaction)", async () => {
      // Revoke guardian 1 and cancel its revokation
      await manager.relay(guardianManager, "revokeGuardian", [wallet.contractAddress, guardian1], wallet, [owner]);
      await manager.relay(guardianManager, "cancelGuardianRevokation", [wallet.contractAddress, guardian1], wallet, [owner]);
      await manager.increaseTime(30);
      await assert.revertWith(guardianManager.confirmGuardianRevokation(wallet.contractAddress, guardian1),
        "GM: no pending guardian revokation for target");
    });
  });

  describe("Guardian Storage", () => {
    it("should not allow non modules to addGuardian", async () => {
      await assert.revertWith(guardianStorage.addGuardian(wallet.contractAddress, guardian4),
        "TS: must be an authorized module to call this method");
    });

    it("should not allow non modules to revokeGuardian", async () => {
      await assert.revertWith(guardianStorage.revokeGuardian(wallet.contractAddress, guardian1),
        "TS: must be an authorized module to call this method");
    });
  });
});
