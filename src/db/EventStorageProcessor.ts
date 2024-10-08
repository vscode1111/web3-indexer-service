import Bluebird from 'bluebird';
import { Interface, Result } from 'ethers';
import { services } from 'index';
import { ServiceBroker } from 'moleculer';
import { DataSource, Repository } from 'typeorm';
import {
  EventNotifier,
  IdLock,
  MISSING_SERVICE_PRIVATE_KEY,
  Promisable,
  getAddressFromSlot,
  toBoolean2,
  toNumberDecimals,
} from '~common';
import { decodeData } from '~common-back';
import {
  CacheMachine,
  DB_EVENT_CONCURRENCY_COUNT,
  DeployNetworkKey,
  EventStorageProcessorBase,
  StorageProcessor,
  findContracts,
} from '~common-service';
import web3PaymentGatewayABI from '~contracts/abi/WEB3PaymentGateway.json';
import web3ProRataABI from '~contracts/abi/WEB3ProRata.json';
import { Web3IndexerContext } from '~services';
import { Web3BusEvent } from '~types';
import { getCacheContractSettingKey } from '~utils';
import { PaymentGatewayDepositInput, ProRataDepositInput } from './EventStorageProcessor.types';
import {
  Account,
  CBlock,
  CContract,
  CEvent,
  CTransaction,
  Contract,
  ContractType,
  Event,
  Network,
  PBlock,
  PContract,
  PEvent,
  PTransaction,
  PaymentGatewayTransactionItem,
  ProRataTransactionItemType,
  VestingTransactionItem,
  VestingTransactionItemType,
} from './entities';
import { ProRataTransactionItem } from './entities/process/ProRataTransactionItem';

const CONTRACT_EVENT_ENABLE = true;

export class EventStorageProcessor extends EventStorageProcessorBase implements StorageProcessor {
  private web3PaymentGatewayAbiInterfaces!: Interface[];
  private web3PaymentGatewayCurrentAbiInterface!: Interface;
  private web3ProRataAbiInterfaces!: Interface[];
  private web3ProRataCurrentAbiInterface!: Interface;
  private paymentGatewayDepositTopic0!: string;
  private vestingClaimTopic0!: string;
  private vestingRefundTopic0!: string;
  private proRataDepositTopic0!: string;
  private proRataRefundTopic0!: string;
  private babTokenAttestTopic0!: string;
  private babTokenBurnTopic0!: string;
  private babTokenRevokeTopic0!: string;

  private idLock;
  private cacheMachine: CacheMachine;
  private context!: Web3IndexerContext;

  constructor(
    broker: ServiceBroker,
    dataSource: DataSource,
    network: DeployNetworkKey,
    eventNotifier: EventNotifier<Web3BusEvent>,
  ) {
    super(broker, dataSource, network, eventNotifier);

    this.topics0 = [];
    this.idLock = new IdLock();
    this.cacheMachine = new CacheMachine();
  }

  async start() {
    this.web3PaymentGatewayAbiInterfaces = [new Interface(web3PaymentGatewayABI)];
    this.web3PaymentGatewayCurrentAbiInterface = this.web3PaymentGatewayAbiInterfaces[0];

    this.web3PaymentGatewayAbiInterfaces = [new Interface(web3ProRataABI)];
    this.web3ProRataCurrentAbiInterface = this.web3PaymentGatewayAbiInterfaces[0];

    const context = services.getNetworkContext(this.network);
    if (!context) {
      throw MISSING_SERVICE_PRIVATE_KEY;
    }
    this.context = context;

    const { emptyWeb3PaymentGateway, emptyWeb3Vesting, emptyWeb3pProRata, emptyBABToken } = context;
    this.paymentGatewayDepositTopic0 = await this.setTopic0(
      emptyWeb3PaymentGateway.filters.Deposit(),
    );

    this.vestingClaimTopic0 = await this.setTopic0(emptyWeb3Vesting.filters.Claim());
    this.vestingRefundTopic0 = await this.setTopic0(emptyWeb3Vesting.filters.Refund());

    this.proRataDepositTopic0 = await this.setTopic0(emptyWeb3pProRata.filters.Deposit());
    this.proRataRefundTopic0 = await this.setTopic0(emptyWeb3pProRata.filters.Refund());

    this.babTokenAttestTopic0 = await this.setTopic0(emptyBABToken.filters.Attest());
    this.babTokenBurnTopic0 = await this.setTopic0(emptyBABToken.filters.Burn());
    this.babTokenRevokeTopic0 = await this.setTopic0(emptyBABToken.filters.Revoke());
  }

  async getOrSaveAccount(address: string, accountRepository: Repository<Account>) {
    return await this.idLock.tryInvoke<Account>(`account_${Account}`, async () => {
      let dbAccount = await accountRepository.findOneBy({ address });
      if (!dbAccount) {
        dbAccount = new Account();
        dbAccount.address = address;
        await accountRepository.save(dbAccount);
      }
      return dbAccount;
    });
  }

  private async savePaymentGatewayTransactionItem({
    event,
    dbNetwork,
    paymentGatewayTransactionItemRepository,
    accountRepository,
  }: {
    event: Event;
    dbNetwork: Network;
    paymentGatewayTransactionItemRepository: Repository<PaymentGatewayTransactionItem>;
    accountRepository: Repository<Account>;
  }): Promise<Web3BusEvent | null> {
    const contractAddress = event.contract.address;
    const network = dbNetwork.name as DeployNetworkKey;

    const decodedDepositInput = this.tryDecode<PaymentGatewayDepositInput>(
      event.transactionHash.input,
      this.web3PaymentGatewayAbiInterfaces,
      this.web3PaymentGatewayCurrentAbiInterface,
    );
    const userId = decodedDepositInput.userId;
    const transactionId = decodedDepositInput.transactionId;
    const isSig = decodedDepositInput.signature !== undefined;

    const dbPaymentGatewayTransactionItem = new PaymentGatewayTransactionItem();

    const networkId = dbNetwork.id;
    dbPaymentGatewayTransactionItem.networkId = networkId;
    dbPaymentGatewayTransactionItem.network = dbNetwork;
    dbPaymentGatewayTransactionItem.contract = event.contract;
    dbPaymentGatewayTransactionItem.contract.networkId = networkId;
    dbPaymentGatewayTransactionItem.transaction = event.transactionHash;
    dbPaymentGatewayTransactionItem.transaction.networkId = networkId;
    const account = getAddressFromSlot(event.topic1);
    const dbAccount = await this.getOrSaveAccount(account, accountRepository);
    dbPaymentGatewayTransactionItem.account = dbAccount;
    const eventData = decodeData(event.data!, ['uint256']);

    const decimals = await this.cacheMachine.call(
      () => getCacheContractSettingKey(network, contractAddress),
      async () => {
        const { getWeb3PaymentGateway, getErc20Token } = this.context;
        const tokenAddress = await getWeb3PaymentGateway(contractAddress).erc20Token();
        return getErc20Token(tokenAddress).decimals();
      },
    );

    dbPaymentGatewayTransactionItem.userId = userId;
    dbPaymentGatewayTransactionItem.transactionId = transactionId;
    dbPaymentGatewayTransactionItem.isSig = isSig;
    const amount = toNumberDecimals(BigInt(eventData[0]), decimals);
    dbPaymentGatewayTransactionItem.amount = amount;
    const timestamp = event.transactionHash.block.timestamp;
    dbPaymentGatewayTransactionItem.timestamp = timestamp;

    await paymentGatewayTransactionItemRepository.save(dbPaymentGatewayTransactionItem);
    return {
      event: 'PAYMENT_GATEWAY_CONTRACT_DEPOSIT',
      data: {
        network,
        contractAddress,
        userId,
        transactionId,
        isSig,
        account,
        amount,
        timestamp,
        tx: event.transactionHash.hash,
      },
    };
  }

  private async saveVestingTransactionItem({
    event,
    dbNetwork,
    type,
    vestingTransactionItemRepository,
    accountRepository,
  }: {
    event: Event;
    dbNetwork: Network;
    type: VestingTransactionItemType;
    vestingTransactionItemRepository: Repository<VestingTransactionItem>;
    accountRepository: Repository<Account>;
  }): Promise<Web3BusEvent | null> {
    const isClaim = type === 'claim';

    const contractAddress = event.contract.address;
    const network = dbNetwork.name as DeployNetworkKey;

    const dbVestingTransactionItem = new VestingTransactionItem();
    const networkId = dbNetwork.id;
    dbVestingTransactionItem.networkId = networkId;
    dbVestingTransactionItem.network = dbNetwork;
    dbVestingTransactionItem.contract = event.contract;
    dbVestingTransactionItem.contract.networkId = networkId;
    dbVestingTransactionItem.type = type;
    dbVestingTransactionItem.transaction = event.transactionHash;
    dbVestingTransactionItem.transaction.networkId = networkId;
    const account = getAddressFromSlot(event.topic1);
    const dbAccount = await this.getOrSaveAccount(account, accountRepository);
    dbVestingTransactionItem.account = dbAccount;

    let amount = 0;

    if (isClaim) {
      const decimals = await this.cacheMachine.call(
        () => getCacheContractSettingKey(network, contractAddress),
        async () => {
          const { getWeb3Vesting, getErc20Token } = this.context;
          const tokenAddress = await getWeb3Vesting(contractAddress).erc20Token();
          return getErc20Token(tokenAddress).decimals();
        },
      );

      const eventData = decodeData(event.data!, ['uint256']);
      amount = toNumberDecimals(BigInt(eventData[0]), decimals);
      dbVestingTransactionItem.amount = amount;
    }

    const timestamp = event.transactionHash.block.timestamp;
    dbVestingTransactionItem.timestamp = timestamp;

    await vestingTransactionItemRepository.save(dbVestingTransactionItem);

    if (isClaim) {
      return {
        event: 'VESTING_CONTRACT_CLAIM',
        data: {
          network,
          contractAddress,
          account,
          amount,
          timestamp,
          tx: event.transactionHash.hash,
        },
      };
    } else {
      return {
        event: 'VESTING_CONTRACT_REFUND',
        data: {
          network,
          contractAddress,
          account,
          timestamp,
          tx: event.transactionHash.hash,
        },
      };
    }
  }

  private async saveProRataTransactionItem({
    event,
    dbNetwork,
    contractType,
    proRataTransactionItemType,
    proRataTransactionItemRepository,
    accountRepository,
  }: {
    event: Event;
    dbNetwork: Network;
    contractType: ContractType;
    proRataTransactionItemType: ProRataTransactionItemType;
    proRataTransactionItemRepository: Repository<ProRataTransactionItem>;
    accountRepository: Repository<Account>;
  }): Promise<Web3BusEvent | null> {
    const contractAddress = event.contract.address;
    const network = dbNetwork.name as DeployNetworkKey;

    const isDeposit = proRataTransactionItemType === 'deposit';

    let transactionId;
    let isSig;
    let isBoost = toBoolean2(Number(event.topic2));
    let boostAmount = 0;
    let boostExchangeRate;
    let boostAverageExchangeRate = 0;

    const dbProRataTransactionItem = new ProRataTransactionItem();

    if (isDeposit) {
      const decodedDepositInputs = this.tryDecode<ProRataDepositInput>(
        event.transactionHash.input,
        this.web3ProRataAbiInterfaces,
        this.web3ProRataCurrentAbiInterface,
      );
      const decodedDepositInput = decodedDepositInputs[0];

      dbProRataTransactionItem.isBoost = isBoost;
      boostExchangeRate = toNumberDecimals(decodedDepositInput[2]);
      dbProRataTransactionItem.boostExchangeRate = boostExchangeRate;
      isSig = decodedDepositInput[5] !== undefined;
      transactionId = decodedDepositInput[3];
      dbProRataTransactionItem.transactionId = transactionId;
      dbProRataTransactionItem.isSig = isSig;
    }

    const networkId = dbNetwork.id;
    dbProRataTransactionItem.networkId = networkId;
    dbProRataTransactionItem.network = dbNetwork;
    dbProRataTransactionItem.type = proRataTransactionItemType;
    dbProRataTransactionItem.contract = event.contract;
    dbProRataTransactionItem.contract.networkId = networkId;
    dbProRataTransactionItem.transaction = event.transactionHash;
    dbProRataTransactionItem.transaction.networkId = networkId;
    const account = getAddressFromSlot(event.topic1);
    const dbAccount = await this.getOrSaveAccount(account, accountRepository);
    dbProRataTransactionItem.account = dbAccount;

    let eventData: Result;

    if (isDeposit) {
      eventData = decodeData(event.data!, ['uint256', 'uint256']);
    } else {
      eventData = decodeData(event.data!, ['uint256', 'uint256', 'uint256']);
      boostAverageExchangeRate = toNumberDecimals(BigInt(eventData[2]));
    }

    const { baseDecimals, boostDecimals } = await this.cacheMachine.call(
      () => getCacheContractSettingKey(network, contractAddress),
      async () => {
        const { getWeb3pProRata } = this.context;

        const web3ProRata = getWeb3pProRata(contractAddress);

        const [baseDecimals, boostDecimals] = await Promise.all([
          await web3ProRata.baseDecimals(),
          await web3ProRata.boostDecimals(),
        ]);

        return {
          baseDecimals,
          boostDecimals,
        };
      },
    );

    const baseAmount = toNumberDecimals(BigInt(eventData[0]), baseDecimals);
    dbProRataTransactionItem.baseAmount = baseAmount;
    boostAmount = toNumberDecimals(BigInt(eventData[1]), boostDecimals);

    dbProRataTransactionItem.boostAmount = boostAmount;
    const timestamp = event.transactionHash.block.timestamp;
    dbProRataTransactionItem.timestamp = timestamp;

    await proRataTransactionItemRepository.save(dbProRataTransactionItem);

    const tx = event.transactionHash.hash;

    if (proRataTransactionItemType === 'deposit') {
      return {
        event: 'PRO_RATA_CONTRACT_DEPOSIT',
        data: {
          network,
          contractType,
          contractAddress,
          account,
          isBoost,
          baseAmount,
          boostAmount,
          boostExchangeRate,
          transactionId,
          isSig,
          timestamp,
          tx,
        },
      };
    } else {
      return {
        event: 'PRO_RATA_CONTRACT_REFUND',
        data: {
          network,
          contractType,
          contractAddress,
          account,
          isBoost,
          baseAmount,
          boostAmount,
          boostAverageExchangeRate,
          timestamp,
          tx,
        },
      };
    }
  }

  private async processBABTokenTransaction({
    event,
    dbNetwork,
    contractType,
    attested,
  }: {
    event: Event;
    dbNetwork: Network;
    contractType: ContractType;
    attested: boolean;
  }): Promise<Web3BusEvent | null> {
    const contractAddress = event.contract.address;
    const network = dbNetwork.name as DeployNetworkKey;
    const account = getAddressFromSlot(event.topic1);
    const timestamp = event.transactionHash.block.timestamp;
    const tx = event.transactionHash.hash;

    return {
      event: 'BABT_STATUS_CHANGED',
      data: {
        network,
        contractType,
        contractAddress,
        account,
        attested,
        timestamp,
        tx,
      },
    };
  }

  private async createTransactionItem(
    event: Event,
    paymentGatewayTransactionItemRepository: Repository<PaymentGatewayTransactionItem>,
    vestingTransactionItemRepository: Repository<VestingTransactionItem>,
    proRataTransactionItemRepository: Repository<ProRataTransactionItem>,
    accountRepository: Repository<Account>,
    networkRepository: Repository<Network>,
  ): Promise<Web3BusEvent | null> {
    if (!this.topics0.includes(event.topic0) || !event?.transactionHash?.input) {
      return null;
    }

    const dbNetwork = await networkRepository.findOneBy({ name: this.network });
    if (!dbNetwork) {
      return null;
    }

    if (!event.data) {
      return null;
    }

    const contractType = event.contract.type;

    switch (contractType) {
      case 'payment-gateway':
        if (event.topic0 === this.paymentGatewayDepositTopic0) {
          return this.savePaymentGatewayTransactionItem({
            event,
            dbNetwork,
            paymentGatewayTransactionItemRepository,
            accountRepository,
          });
        }
        break;

      case 'vesting':
        if (event.topic0 === this.vestingClaimTopic0) {
          return this.saveVestingTransactionItem({
            event,
            dbNetwork,
            type: 'claim',
            vestingTransactionItemRepository,
            accountRepository,
          });
        } else if (event.topic0 === this.vestingRefundTopic0) {
          return this.saveVestingTransactionItem({
            event,
            dbNetwork,
            type: 'refund',
            vestingTransactionItemRepository,
            accountRepository,
          });
        }
        break;

      case 'pro-rata':
        if (event.topic0 === this.proRataDepositTopic0) {
          return this.saveProRataTransactionItem({
            event,
            dbNetwork,
            contractType,
            proRataTransactionItemType: 'deposit',
            proRataTransactionItemRepository,
            accountRepository,
          });
        } else if (event.topic0 === this.proRataRefundTopic0) {
          return this.saveProRataTransactionItem({
            event,
            dbNetwork,
            contractType,
            proRataTransactionItemType: 'refund',
            proRataTransactionItemRepository,
            accountRepository,
          });
        }
        break;

      case 'babt':
        if (event.topic0 === this.babTokenAttestTopic0) {
          return this.processBABTokenTransaction({
            event,
            dbNetwork,
            contractType,
            attested: true,
          });
        } else if (
          event.topic0 === this.babTokenRevokeTopic0 ||
          event.topic0 === this.babTokenBurnTopic0
        ) {
          return this.processBABTokenTransaction({
            event,
            dbNetwork,
            contractType,
            attested: false,
          });
        }
        break;
    }

    return null;
  }

  async process(
    onProcessEvent?: (event: Event) => Promisable<void>,
    onContractEvent?: (event: Web3BusEvent) => Promisable<void>,
  ) {
    await this.dataSource.transaction(async (entityManager) => {
      const networkRepository = entityManager.getRepository(Network);
      const contractRepository = entityManager.getRepository(Contract);
      const eventRepository = entityManager.getRepository(Event);
      const paymentGatewayTransactionItemRepository = entityManager.getRepository(
        PaymentGatewayTransactionItem,
      );
      const vestingTransactionItemRepository = entityManager.getRepository(VestingTransactionItem);
      const proRataTransactionItemRepository = entityManager.getRepository(ProRataTransactionItem);
      const accountRepository = entityManager.getRepository(Account);

      const contracts = await findContracts({
        contractRepository,
        networkRepository,
        network: this.network,
      });

      await Bluebird.map(
        contracts,
        async (contract) => {
          const { address, processBlockNumber, syncBlockNumber } = contract;

          const from = processBlockNumber;
          const to = syncBlockNumber - 1;

          if (from > to) {
            return;
          }

          const events = await eventRepository
            .createQueryBuilder(CEvent)
            .leftJoin(PEvent('contract'), CContract)
            .leftJoin(PEvent('transactionHash'), CTransaction)
            .leftJoin(PTransaction('block'), CBlock)
            .select([
              PEvent('topic0'),
              PEvent('topic1'),
              PEvent('topic2'),
              PEvent('data'),
              PContract('address'),
              PContract('type'),
              PTransaction('hash'),
              PTransaction('input'),
              PBlock('number'),
              PBlock('timestamp'),
            ])
            .where(`${PContract('address')} = :address`, { address })
            .andWhere(`${PBlock('number')} between ${from} and ${to}`)
            .addOrderBy(PBlock('number'), 'ASC')
            .getMany();

          for (const event of events) {
            const contractEvent = await this.createTransactionItem(
              event,
              paymentGatewayTransactionItemRepository,
              vestingTransactionItemRepository,
              proRataTransactionItemRepository,
              accountRepository,
              networkRepository,
            );

            if (onProcessEvent) {
              await onProcessEvent(event);
            }

            if (contractEvent && CONTRACT_EVENT_ENABLE) {
              await this.eventNotifier.send(contractEvent);
              if (onContractEvent) {
                await onContractEvent(contractEvent);
              }
            }
          }

          contract.processBlockNumber = to + 1;
          await contractRepository.save(contract);
        },
        { concurrency: DB_EVENT_CONCURRENCY_COUNT },
      );
    });
  }
}
