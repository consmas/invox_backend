import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents,decimal,discountQuote } from '../src/server/money';

test('money preserves cents beyond JavaScript safe integers',()=>{
  assert.equal(decimal(cents('9007199254740991.23')),'9007199254740991.23');
  assert.equal(decimal(cents('0.1')),'0.10');
  for(const value of ['-1','NaN','Infinity','1.001','1e4','10000000000000000'])assert.throws(()=>cents(value));
});
test('annual simple discount reproduces the supplied GHS example',()=>{
  assert.deepEqual(discountQuote({amount:'100000',model:'annual_simple',rate:'18',days:90,basis:365}),{
    financed_amount:'100000.00',discount_amount:'4438.36',other_fees:'0.00',net_supplier_proceeds:'95561.64',
  });
});
test('flat, fixed and Actual/360 models round half up and retain explicit fees',()=>{
  assert.equal(discountQuote({amount:'100',model:'flat',rate:'2.5',other_fees:'1.25'}).net_supplier_proceeds,'96.25');
  assert.equal(discountQuote({amount:'100',model:'fixed',fixed_fee:'3.10',other_fees:'1'}).net_supplier_proceeds,'95.90');
  assert.equal(discountQuote({amount:'100000',model:'annual_simple',rate:'18',days:90,basis:360}).discount_amount,'4500.00');
  assert.equal(discountQuote({amount:'1',model:'flat',rate:'0.5'}).discount_amount,'0.01');
  assert.throws(()=>discountQuote({amount:'100',model:'fixed',fixed_fee:'100'}));
  assert.throws(()=>discountQuote({amount:'100',model:'annual_simple',rate:'18',days:-1,basis:365}));
});
