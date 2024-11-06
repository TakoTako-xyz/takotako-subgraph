import { Address, BigDecimal, dataSource, log } from "@graphprotocol/graph-ts";
import { PriceOracleUpdated } from "../generated/LendingPoolAddressesProvider/LendingPoolAddressesProvider";
import { TakoTakoProtocol } from "./constants";
import {
  BorrowingDisabledOnReserve,
  BorrowingEnabledOnReserve,
  CollateralConfigurationChanged,
  ReserveActivated,
  ReserveDeactivated,
  ReserveFactorChanged,
  ReserveInitialized,
} from "../generated/LendingPoolConfigurator/LendingPoolConfigurator";
import {
  Borrow,
  Deposit,
  LiquidationCall,
  Paused,
  Repay,
  ReserveDataUpdated,
  ReserveUsedAsCollateralDisabled,
  ReserveUsedAsCollateralEnabled,
  Unpaused,
  Withdraw,
} from "../generated/LendingPool/LendingPool";
import { GToken } from "../generated/LendingPool/GToken";
import { ChefIncentivesController } from "../generated/LendingPool/ChefIncentivesController";
import { Transfer as CollateralTransfer } from "../generated/templates/AToken/AToken";
import { Transfer as VariableTransfer } from "../generated/templates/VariableDebtToken/VariableDebtToken";
import { Market } from "../generated/schema";
import {
  ProtocolData,
  _handleBorrow,
  _handleBorrowingDisabledOnReserve,
  _handleBorrowingEnabledOnReserve,
  _handleCollateralConfigurationChanged,
  _handleDeposit,
  _handleLiquidate,
  _handlePaused,
  _handlePriceOracleUpdated,
  _handleRepay,
  _handleReserveActivated,
  _handleReserveDataUpdated,
  _handleReserveDeactivated,
  _handleReserveFactorChanged,
  _handleReserveInitialized,
  _handleReserveUsedAsCollateralDisabled,
  _handleReserveUsedAsCollateralEnabled,
  _handleTransfer,
  _handleUnpaused,
  _handleWithdraw,
} from "./_mapping";
import {
  DEFAULT_DECIMALS,
  exponentToBigDecimal,
  PositionSide,
} from "./constants";

function getProtocolData(): ProtocolData {
  const network: string = dataSource.network();
  return new ProtocolData(
    TakoTakoProtocol.PROTOCOL_ADDRESS,
    TakoTakoProtocol.NAME,
    TakoTakoProtocol.SLUG,
    TakoTakoProtocol.NETWORK
  );
}

///////////////////////////////////////////////
///// LendingPoolAddressProvider Handlers /////
///////////////////////////////////////////////

export function handlePriceOracleUpdated(event: PriceOracleUpdated): void {
  _handlePriceOracleUpdated(event.params.newAddress, getProtocolData());
}

//////////////////////////////////////
///// Lending Pool Configuration /////
//////////////////////////////////////

export function handleReserveInitialized(event: ReserveInitialized): void {
  // This function handles market entity from reserve creation event
  // Attempt to load or create the market implementation

  _handleReserveInitialized(
    event,
    event.params.asset,
    event.params.aToken,
    event.params.variableDebtToken,
    getProtocolData()
    // No stable debt token in the protocol
  );
}

export function handleCollateralConfigurationChanged(
  event: CollateralConfigurationChanged
): void {
  _handleCollateralConfigurationChanged(
    event.params.asset,
    event.params.liquidationBonus,
    event.params.liquidationThreshold,
    event.params.ltv,
    getProtocolData()
  );
}

export function handleBorrowingEnabledOnReserve(
  event: BorrowingEnabledOnReserve
): void {
  _handleBorrowingEnabledOnReserve(event.params.asset, getProtocolData());
}

export function handleBorrowingDisabledOnReserve(
  event: BorrowingDisabledOnReserve
): void {
  _handleBorrowingDisabledOnReserve(event.params.asset, getProtocolData());
}

export function handleReserveActivated(event: ReserveActivated): void {
  _handleReserveActivated(event.params.asset, getProtocolData());
}

export function handleReserveDeactivated(event: ReserveDeactivated): void {
  _handleReserveDeactivated(event.params.asset, getProtocolData());
}

export function handleReserveFactorChanged(event: ReserveFactorChanged): void {
  _handleReserveFactorChanged(
    event.params.asset,
    event.params.factor,
    getProtocolData()
  );
}

/////////////////////////////////
///// Lending Pool Handlers /////
/////////////////////////////////

export function handleReserveDataUpdated(event: ReserveDataUpdated): void {
  const protocolData = getProtocolData();

  // update rewards if there is an incentive controller
  const market = Market.load(event.params.reserve.toHexString());
  if (!market) {
    log.warning("[handleReserveDataUpdated] Market not found", [
      event.params.reserve.toHexString(),
    ]);
    return;
  }

  // Rewards / day calculation
  // rewards per second = totalRewardsPerSecond * (allocPoint / totalAllocPoint)
  // rewards per day = rewardsPerSecond * 60 * 60 * 24
  // Borrow rewards are 3x the rewards per day for deposits

  const gTokenContract = GToken.bind(Address.fromString(market.outputToken!));
  const tryIncentiveController = gTokenContract.try_getIncentivesController();
  if (!tryIncentiveController.reverted) {
    const incentiveControllerContract = ChefIncentivesController.bind(
      tryIncentiveController.value
    );
    const tryPoolInfo = incentiveControllerContract.try_poolInfo(
      Address.fromString(market.outputToken!)
    );
    const tryTotalAllocPoint = incentiveControllerContract.try_totalAllocPoint();
    const tryTotalRewardsPerSecond = incentiveControllerContract.try_rewardsPerSecond();

    if (
      !tryPoolInfo.reverted ||
      !tryTotalAllocPoint.reverted ||
      !tryTotalRewardsPerSecond.reverted
    ) {
      const supplyAllocPoint = tryPoolInfo.value.value1;
      market.supplyAllocPoint = supplyAllocPoint;

      const variableDebtTokenPoolInfo = incentiveControllerContract.try_poolInfo(
        Address.fromString(market._vToken!)
      );

      const borrowAllocPoint = variableDebtTokenPoolInfo.value.value1;
      market.borrowAllocPoint = borrowAllocPoint;

      // calculate rewards per day
      const rewardsPerSecond = tryTotalRewardsPerSecond.value
        .times(tryPoolInfo.value.value1)
        .div(tryTotalAllocPoint.value);

      market.rewardsPerSecond = rewardsPerSecond;
      market.totalAllocPoint = tryTotalAllocPoint.value;
    }
  }
  market.save();

  // update gToken price
  let assetPriceUSD: BigDecimal;

  const tryPrice = gTokenContract.try_getAssetPrice();
  if (tryPrice.reverted) {
    log.warning(
      "[handleReserveDataUpdated] Token price not found in Market: {}",
      [market.id]
    );
    return;
  }

  // get asset price normally
  assetPriceUSD = tryPrice.value
    .toBigDecimal()
    .div(exponentToBigDecimal(DEFAULT_DECIMALS));

  _handleReserveDataUpdated(
    event,
    event.params.liquidityRate,
    event.params.liquidityIndex,
    event.params.variableBorrowRate,
    event.params.stableBorrowRate,
    protocolData,
    event.params.reserve,
    assetPriceUSD
  );
}

export function handleReserveUsedAsCollateralEnabled(
  event: ReserveUsedAsCollateralEnabled
): void {
  // This Event handler enables a reserve/market to be used as collateral
  _handleReserveUsedAsCollateralEnabled(
    event.params.reserve,
    event.params.user,
    getProtocolData()
  );
}

export function handleReserveUsedAsCollateralDisabled(
  event: ReserveUsedAsCollateralDisabled
): void {
  // This Event handler disables a reserve/market being used as collateral
  _handleReserveUsedAsCollateralDisabled(
    event.params.reserve,
    event.params.user,
    getProtocolData()
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function handlePaused(event: Paused): void {
  _handlePaused(getProtocolData());
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function handleUnpaused(event: Unpaused): void {
  _handleUnpaused(getProtocolData());
}

export function handleDeposit(event: Deposit): void {
  _handleDeposit(
    event,
    event.params.amount,
    event.params.reserve,
    getProtocolData(),
    event.params.onBehalfOf
  );
}

export function handleWithdraw(event: Withdraw): void {
  _handleWithdraw(
    event,
    event.params.amount,
    event.params.reserve,
    getProtocolData(),
    event.params.to
  );
}

export function handleBorrow(event: Borrow): void {
  _handleBorrow(
    event,
    event.params.amount,
    event.params.reserve,
    getProtocolData(),
    event.params.onBehalfOf
  );
}

export function handleRepay(event: Repay): void {
  _handleRepay(
    event,
    event.params.amount,
    event.params.reserve,
    getProtocolData(),
    event.params.user // address that is getting debt reduced
  );
}

export function handleLiquidationCall(event: LiquidationCall): void {
  _handleLiquidate(
    event,
    event.params.liquidatedCollateralAmount,
    event.params.collateralAsset,
    getProtocolData(),
    event.params.liquidator,
    event.params.user,
    event.params.debtAsset,
    event.params.debtToCover
  );
}

/////////////////////////
//// Transfer Events ////
/////////////////////////

export function handleCollateralTransfer(event: CollateralTransfer): void {
  _handleTransfer(
    event,
    getProtocolData(),
    PositionSide.LENDER,
    event.params.to,
    event.params.from
  );
}

export function handleVariableTransfer(event: VariableTransfer): void {
  _handleTransfer(
    event,
    getProtocolData(),
    PositionSide.BORROWER,
    event.params.to,
    event.params.from
  );
}

///////////////////
///// Helpers /////
///////////////////
