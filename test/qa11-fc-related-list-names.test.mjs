// QA 1.1 finding 21: the standard related lists that are not named Related<Object>List were never matched.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';
const F = extractFunctions('field-cleaner.js', ['fcRelatedListIsOf', 'fcRelatedListEdit']);

describe('a standard related list with a name of its own belongs to its object', () => {
  it('Open Activities and Activity History are lists of tasks, events and the activity fields', () => {
    for (const o of ['Task', 'Event', 'Activity']) {
      expect(F.fcRelatedListIsOf('RelatedActivityList', o)).toBe(true);
      expect(F.fcRelatedListIsOf('RelatedHistoryList', o)).toBe(true);
    }
  });
  it('opportunity products, opportunity contact roles and an account’s related contacts', () => {
    expect(F.fcRelatedListIsOf('RelatedLineItemList', 'OpportunityLineItem')).toBe(true);
    expect(F.fcRelatedListIsOf('RelatedContactRoleList', 'OpportunityContactRole')).toBe(true);
    expect(F.fcRelatedListIsOf('RelatedContactAccountRelationList', 'AccountContactRelation')).toBe(true);
    expect(F.fcRelatedListIsOf('RelatedAccountContactRelationList', 'AccountContactRelation')).toBe(true);
  });
  it('another object’s list stays another object’s; an object name that is a property of every object matches nothing', () => {
    expect(F.fcRelatedListIsOf('RelatedActivityList', 'Contact')).toBe(false);
    expect(F.fcRelatedListIsOf('RelatedLineItemList', 'Task')).toBe(false);
    expect(F.fcRelatedListIsOf('RelatedContactList', 'Contact')).toBe(true);
    expect(F.fcRelatedListIsOf('RelatedActivityList', 'constructor')).toBe(false);
    expect(F.fcRelatedListIsOf('RelatedActivityList', 'toString')).toBe(false);
  });
});

describe('the column is found in those lists', () => {
  const layout = () => ({ relatedLists: [
    { relatedList: 'RelatedActivityList', fields: ['TASK.SUBJECT', 'Priority_Code__c', 'TASK.DUE_DATE'], sortField: 'Priority_Code__c', sortOrder: 'Asc' },
    { relatedList: 'RelatedHistoryList', fields: ['TASK.SUBJECT', 'Activity.Priority_Code__c'] },
    { relatedList: 'RelatedLineItemList', fields: ['OPPORTUNITY.PRODUCT.NAME', 'Margin__c'] },
    { relatedList: 'RelatedContactList', fields: ['FULL_NAME', 'Priority_Code__c'] },
  ] });
  it('a custom activity field picked on Task is a column of both activity lists — bare or with the activity’s name', () => {
    const m = layout();
    expect(F.fcRelatedListEdit(m, 'Task', 'Priority_Code__c', null)).toBe(2);
    expect(m.relatedLists[0].fields).toEqual(['TASK.SUBJECT', 'TASK.DUE_DATE']);
    expect(m.relatedLists[0].sortField).toBeUndefined();
    expect(m.relatedLists[1].fields).toEqual(['TASK.SUBJECT']);
    expect(m.relatedLists[3].fields).toEqual(['FULL_NAME', 'Priority_Code__c']);   // the contacts list is not an activity list
  });
  it('an opportunity product field is a column of the Products list; replacing it puts the new field there', () => {
    const m = layout();
    expect(F.fcRelatedListEdit(m, 'OpportunityLineItem', 'Margin__c', 'Margin2__c')).toBe(1);
    expect(m.relatedLists[2].fields).toEqual(['OPPORTUNITY.PRODUCT.NAME', 'Margin2__c']);
  });
  it('a layout without the column is not counted', () => {
    expect(F.fcRelatedListEdit(layout(), 'Event', 'Other__c', null)).toBe(0);
    expect(F.fcRelatedListEdit(layout(), 'OpportunityContactRole', 'Margin__c', null)).toBe(0);
  });
});
