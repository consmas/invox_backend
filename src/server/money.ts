import { ApiError, requireCondition } from './errors';

const MAX_CENTS=BigInt('999999999999999999');
export function cents(value:string):bigint {
  requireCondition(/^\d+(\.\d{1,2})?$/.test(value),422,'Use a decimal amount with at most two decimal places');
  const [whole,fraction='']=value.split('.');
  const amount=BigInt(whole)*BigInt(100)+BigInt(fraction.padEnd(2,'0'));
  requireCondition(amount<=MAX_CENTS,422,'Amount exceeds supported precision');
  return amount;
}
export function decimal(value:bigint):string {
  const negative=value<BigInt(0);const absolute=negative?-value:value;
  return `${negative?'-':''}${absolute/BigInt(100)}.${String(absolute%BigInt(100)).padStart(2,'0')}`;
}
function rounded(numerator:bigint,denominator:bigint){return (numerator+denominator/BigInt(2))/denominator;}
export function discountQuote(input:{amount:string;model:'annual_simple'|'flat'|'fixed';rate?:string;days?:number;basis?:360|365;fixed_fee?:string;other_fees?:string}) {
  const principal=cents(input.amount);const fees=cents(input.other_fees??'0');
  requireCondition(principal>BigInt(0),422,'Financing amount must be positive');
  let discount:bigint;
  if(input.model==='fixed')discount=cents(input.fixed_fee??'0');
  else {
    const rate=input.rate??'';
    requireCondition(/^\d+(\.\d{1,6})?$/.test(rate),422,'Rate must be a percentage with at most six decimal places');
    const [whole,fraction='']=rate.split('.');const units=BigInt(whole)*BigInt(1000000)+BigInt(fraction.padEnd(6,'0'));
    requireCondition(units<=BigInt(100000000),422,'Rate cannot exceed 100 percent');
    let numerator=principal*units;let denominator=BigInt(100000000);
    if(input.model==='annual_simple'){
      requireCondition(Number.isInteger(input.days)&&input.days!>=0&&input.days!<=36500,422,'Invalid days to maturity');
      requireCondition(input.basis===360||input.basis===365,422,'Day-count basis must be 360 or 365');
      numerator*=BigInt(input.days!);denominator*=BigInt(input.basis!);
    }else if(input.model!=='flat')throw new ApiError(422,'Unsupported discount model');
    discount=rounded(numerator,denominator);
  }
  requireCondition(discount+fees<principal,422,'Discount and fees must leave positive supplier proceeds');
  return {financed_amount:decimal(principal),discount_amount:decimal(discount),other_fees:decimal(fees),net_supplier_proceeds:decimal(principal-discount-fees)};
}
