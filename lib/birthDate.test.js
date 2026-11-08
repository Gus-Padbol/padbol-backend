import test from 'node:test'; import assert from 'node:assert/strict';
import {validateBirthDate} from './birthDate.js';
const NOW=new Date('2026-11-07T12:00:00Z');
test('31/02 y 29/02 no bisiesto se rechazan',()=>{assert.equal(validateBirthDate('1990-02-31',NOW).code,'INVALID_DATE');assert.equal(validateBirthDate('1991-02-29',NOW).code,'INVALID_DATE');});
test('29/02 bisiesto y edad 5/120 limites',()=>{assert.equal(validateBirthDate('1992-02-29',NOW).ok,true);assert.equal(validateBirthDate('2021-11-07',NOW).ok,true);assert.equal(validateBirthDate('2021-11-08',NOW).code,'AGE_OUT_OF_RANGE');assert.equal(validateBirthDate('1906-11-07',NOW).ok,true);assert.equal(validateBirthDate('1905-11-07',NOW).code,'AGE_OUT_OF_RANGE');});
test('futuro rechazado',()=>{assert.equal(validateBirthDate('2027-01-01',NOW).code,'FUTURE_DATE');});
test('formato invalido',()=>{assert.equal(validateBirthDate('07/11/1990',NOW).code,'INVALID_DATE');});
