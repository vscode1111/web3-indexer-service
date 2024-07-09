import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from "typeorm";
import { C, NF2, P } from "~common";
import { rawDbTable } from "../../tableNames";
import { PaymentGatewayTransactionItem } from "../process";
import { Event } from "./Event";
import { Network } from "./Network";

export const contractTypes = ['fcfs', 'sqrp-gated', 'white-list', 'vesting', 'pro-rata', 'pro-rata-sqrp-gated', 'babt'] as const;
export type ContractType = (typeof contractTypes)[number];
const DEFAULT_CONTRACT_TYPE: ContractType = 'fcfs';

@Entity({ name: rawDbTable._contracts })
@Index([P<Contract>((p) => p.networkId) as string, P<Contract>((p) => p.address) as string], {
  unique: true,
})
export class Contract {
  @Column()
  @Index()
  networkId!: number;

  @ManyToOne(() => Network, (network) => network.contracts)
  @JoinColumn({
    name: P<Contract>((p) => p.networkId),
    referencedColumnName: P<Network>((p) => p.id),
  })
  network!: Network;

  @PrimaryGeneratedColumn()
  @Index()
  id!: number;

  @Column()
  @Index()
  address!: string;

  @Column({
    type: "enum",
    default: DEFAULT_CONTRACT_TYPE,
    enum: contractTypes,
  })
  type!: ContractType;

  @Column({ nullable: true })
  name!: string;

  @Column({ nullable: true })
  disable!: boolean;
  
  @Column()
  syncBlockNumber!: number;

  @Column()
  processBlockNumber!: number;

  @Column({ type: 'json', nullable: true })
  data!: Object;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => Event, (item) => item.contractId)
  events!: Event[];

  @OneToMany(() => PaymentGatewayTransactionItem, (item) => item.account)
  contractTransactionItems!: PaymentGatewayTransactionItem[];
}

export const  CContract = C(Contract);
export const PContract = NF2<Contract>((name) => `${CContract}.${name}`);
