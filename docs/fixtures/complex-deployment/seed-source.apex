// SFTK complex-deployment fixture — SOURCE org. Everything is prefixed "SFTK CX"
// so it can be found and removed (see cleanup.apex). Standard objects only, so
// it runs in any org. Deliberately exercises what breaks vanilla deployments:
//   • Account hierarchy (ParentId self-lookup, 3 levels)   • Contact.ReportsToId chain
//   • duplicate names on both Account and Contact           • unicode / apostrophe names
//   • Opportunity → OpportunityContactRole (junction)       • Product2 → PricebookEntry → OpportunityLineItem
//   • Case.ParentId + CaseComment                            • Campaign hierarchy + CampaignMember (Contact AND Lead)
//   • Task / Event with polymorphic WhoId / WhatId           • Asset (Account+Contact+Product2, ParentId)
//   • Contract, Order + OrderItem (no name, no external id)  • Person Accounts (+ a Case on the hidden Contact)
//   • Individual (if enabled)                                • ContentVersion + ContentDocumentLink (📎 files)
// duplicate rules are part of the test: the fixture carries duplicates on purpose
Database.DMLOptions dmo = new Database.DMLOptions(); dmo.DuplicateRuleHeader.allowSave = true; dmo.DuplicateRuleHeader.runAsCurrentUser = true; dmo.optAllOrNone = true;
Savepoint sp = Database.setSavepoint();
try {
  // ── Accounts: a 3-level hierarchy, a duplicate pair, a unicode name ──
  Account hold = new Account(Name='SFTK CX Holding', Industry='Technology', Type='Customer - Direct', Rating='Hot', Website='https://sftk-cx.example', BillingCountry='Israel', BillingCity='Tel Aviv', Phone='+972-3-000-0001', AnnualRevenue=12000000, NumberOfEmployees=850, Description='Root of the fixture hierarchy. Line two.\nLine three with "quotes" and <angle> brackets.');
  Database.insert(hold, dmo);
  List<Account> subs = new List<Account>{
    new Account(Name='SFTK CX Europe GmbH', ParentId=hold.Id, Industry='Manufacturing', BillingCountry='Germany', BillingCity='Berlin', AnnualRevenue=4500000, NumberOfEmployees=120),
    new Account(Name='SFTK CX Americas Inc', ParentId=hold.Id, Industry='Retail', BillingCountry='United States', BillingState='NY', BillingCity='New York', AnnualRevenue=6100000, NumberOfEmployees=300),
    new Account(Name='SFTK CX O\'Brien & Söhne — Ünïcode', ParentId=hold.Id, Industry='Consulting', BillingCountry='Austria', BillingCity='Wien', AnnualRevenue=800000),
    new Account(Name='SFTK CX Duplicate Name', Industry='Energy', BillingCity='Haifa', AnnualRevenue=1),
    new Account(Name='SFTK CX Duplicate Name', Industry='Energy', BillingCity='Eilat', AnnualRevenue=2),
    new Account(Name='SFTK CX Orphan Field Test', Industry='Media', Sic='1234', TickerSymbol='SFTK', Ownership='Private')
  };
  Database.insert(subs, dmo);
  Account grand = new Account(Name='SFTK CX Berlin Lab', ParentId=subs[0].Id, Industry='Biotechnology', BillingCountry='Germany', BillingCity='Berlin');
  Database.insert(grand, dmo);

  // ── Contacts with a ReportsTo chain, a duplicate name, a shared email ──
  Contact ceo = new Contact(FirstName='Dana', LastName='SFTK CX Levi', AccountId=hold.Id, Title='CEO', Email='dana.levi@sftk-cx.example', Phone='+972-50-000-0001', MailingCountry='Israel', Birthdate=Date.newInstance(1980, 3, 14), LeadSource='Web');
  Database.insert(ceo, dmo);
  Contact vp = new Contact(FirstName='Noam', LastName='SFTK CX Peretz', AccountId=hold.Id, Title='VP Sales', ReportsToId=ceo.Id, Email='noam.peretz@sftk-cx.example', LeadSource='Partner Referral');
  Database.insert(vp, dmo);
  List<Contact> team = new List<Contact>{
    new Contact(FirstName='Mia', LastName='SFTK CX Schmidt', AccountId=subs[0].Id, Title='Country Manager', ReportsToId=vp.Id, Email='mia.schmidt@sftk-cx.example', MailingCountry='Germany'),
    new Contact(FirstName='Liam', LastName='SFTK CX Carter', AccountId=subs[1].Id, Title='Country Manager', ReportsToId=vp.Id, Email='liam.carter@sftk-cx.example', MailingCountry='United States'),
    new Contact(FirstName='Mia', LastName='SFTK CX Schmidt', AccountId=subs[2].Id, Title='Duplicate-name twin', Email='mia.schmidt@sftk-cx.example'),
    new Contact(FirstName='Yael', LastName='SFTK CX Ünïcode-O\'Neil', AccountId=grand.Id, Title='Lab lead', ReportsToId=vp.Id, Email='yael@sftk-cx.example'),
    new Contact(FirstName='Solo', LastName='SFTK CX NoAccount', Email='solo@sftk-cx.example', Description='Private contact — no account')
  };
  Database.insert(team, dmo);

  // ── Products, standard pricebook entries, opportunities, line items, contact roles ──
  Id stdPb = [SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1].Id;
  List<Product2> prods = new List<Product2>{
    new Product2(Name='SFTK CX Widget', ProductCode='SFTK-CX-W', IsActive=true, Family='Hardware'),
    new Product2(Name='SFTK CX Service Plan', ProductCode='SFTK-CX-S', IsActive=true, Family='Services'),
    new Product2(Name='SFTK CX Licence', ProductCode='SFTK-CX-L', IsActive=true)
  };
  Database.insert(prods, dmo);
  List<PricebookEntry> pbes = new List<PricebookEntry>();
  for (Product2 p : prods) pbes.add(new PricebookEntry(Pricebook2Id=stdPb, Product2Id=p.Id, UnitPrice=100, IsActive=true, UseStandardPrice=false));
  Database.insert(pbes, dmo);
  Pricebook2 custPb = new Pricebook2(Name='SFTK CX Partner Prices', IsActive=true);
  Database.insert(custPb, dmo);
  List<PricebookEntry> pbes2 = new List<PricebookEntry>();
  for (Product2 p : prods) pbes2.add(new PricebookEntry(Pricebook2Id=custPb.Id, Product2Id=p.Id, UnitPrice=80, IsActive=true, UseStandardPrice=false));
  Database.insert(pbes2, dmo);
  List<Opportunity> opps = new List<Opportunity>{
    new Opportunity(Name='SFTK CX Holding — Platform', AccountId=hold.Id, StageName='Prospecting', CloseDate=Date.today().addDays(60), Amount=250000, Pricebook2Id=stdPb, LeadSource='Web', Type='New Customer', NextStep='Demo'),
    new Opportunity(Name='SFTK CX Europe — Renewal', AccountId=subs[0].Id, StageName='Negotiation/Review', CloseDate=Date.today().addDays(20), Amount=48000, Pricebook2Id=custPb.Id, Type='Existing Customer - Upgrade'),
    new Opportunity(Name='SFTK CX Americas — Pilot', AccountId=subs[1].Id, StageName='Closed Won', CloseDate=Date.today().addDays(-5), Amount=12000, Pricebook2Id=stdPb),
    new Opportunity(Name='SFTK CX Lab — Grant', AccountId=grand.Id, StageName='Qualification', CloseDate=Date.today().addDays(90), Amount=5000)
  };
  Database.insert(opps, dmo);
  Database.insert(new List<OpportunityLineItem>{
    new OpportunityLineItem(OpportunityId=opps[0].Id, PricebookEntryId=pbes[0].Id, Quantity=10, UnitPrice=100, Description='ten widgets'),
    new OpportunityLineItem(OpportunityId=opps[0].Id, PricebookEntryId=pbes[1].Id, Quantity=1, UnitPrice=100),
    new OpportunityLineItem(OpportunityId=opps[1].Id, PricebookEntryId=pbes2[2].Id, Quantity=3, UnitPrice=80),
    new OpportunityLineItem(OpportunityId=opps[2].Id, PricebookEntryId=pbes[0].Id, Quantity=2, UnitPrice=100)
  }, dmo);
  Database.insert(new List<OpportunityContactRole>{
    new OpportunityContactRole(OpportunityId=opps[0].Id, ContactId=ceo.Id, Role='Decision Maker', IsPrimary=true),
    new OpportunityContactRole(OpportunityId=opps[0].Id, ContactId=vp.Id, Role='Economic Buyer'),
    new OpportunityContactRole(OpportunityId=opps[1].Id, ContactId=team[0].Id, Role='Decision Maker', IsPrimary=true),
    new OpportunityContactRole(OpportunityId=opps[2].Id, ContactId=team[1].Id, Role='Evaluator')
  }, dmo);

  // ── Cases with a parent case and comments ──
  Case parentCase = new Case(Subject='SFTK CX Outage — parent', AccountId=hold.Id, ContactId=ceo.Id, Status='New', Origin='Web', Priority='High', Description='Parent case');
  Database.insert(parentCase, dmo);
  List<Case> kids = new List<Case>{
    new Case(Subject='SFTK CX Outage — Berlin', AccountId=subs[0].Id, ContactId=team[0].Id, ParentId=parentCase.Id, Status='Working', Origin='Phone', Priority='Medium'),
    new Case(Subject='SFTK CX Outage — NY', AccountId=subs[1].Id, ContactId=team[1].Id, ParentId=parentCase.Id, Status='Escalated', Origin='Email', Priority='High'),
    new Case(Subject='SFTK CX Billing question', AccountId=subs[2].Id, Status='Closed', Origin='Web', Priority='Low'),
    new Case(Subject='SFTK CX No account', ContactId=team[4].Id, Status='New', Origin='Chat')
  };
  Database.insert(kids, dmo);
  Database.insert(new List<CaseComment>{
    new CaseComment(ParentId=parentCase.Id, CommentBody='SFTK CX first comment', IsPublished=true),
    new CaseComment(ParentId=kids[0].Id, CommentBody='SFTK CX Berlin comment')
  }, dmo);

  // ── Campaign hierarchy + members (Contacts and Leads) ──
  Campaign camp = new Campaign(Name='SFTK CX Launch 2026', IsActive=true, Type='Conference', Status='In Progress', StartDate=Date.today(), EndDate=Date.today().addDays(30), BudgetedCost=50000);
  Database.insert(camp, dmo);
  Campaign sub = new Campaign(Name='SFTK CX Launch 2026 — Berlin', ParentId=camp.Id, IsActive=true, Type='Webinar', Status='Planned');
  Database.insert(sub, dmo);
  List<Lead> leads = new List<Lead>{
    new Lead(FirstName='Omer', LastName='SFTK CX Lead One', Company='SFTK CX Prospect Ltd', Status='Open - Not Contacted', Email='omer@sftk-cx-prospect.example', LeadSource='Web', Industry='Technology'),
    new Lead(FirstName='Tal', LastName='SFTK CX Lead Two', Company='SFTK CX Prospect Ltd', Status='Working - Contacted', Email='tal@sftk-cx-prospect.example'),
    new Lead(LastName='SFTK CX Lead Three', Company='SFTK CX Other Co', Status='Open - Not Contacted')
  };
  Database.insert(leads, dmo);
  Database.insert(new List<CampaignMember>{
    new CampaignMember(CampaignId=camp.Id, ContactId=ceo.Id, Status='Responded'),
    new CampaignMember(CampaignId=camp.Id, ContactId=vp.Id, Status='Sent'),
    new CampaignMember(CampaignId=sub.Id, ContactId=team[0].Id, Status='Sent'),
    new CampaignMember(CampaignId=camp.Id, LeadId=leads[0].Id, Status='Sent'),
    new CampaignMember(CampaignId=sub.Id, LeadId=leads[1].Id, Status='Responded')
  }, dmo);

  // ── Activities: polymorphic WhoId / WhatId ──
  Database.insert(new List<Task>{
    new Task(Subject='SFTK CX Call CEO', WhoId=ceo.Id, WhatId=hold.Id, Status='Not Started', Priority='High', ActivityDate=Date.today().addDays(3)),
    new Task(Subject='SFTK CX Follow up opp', WhatId=opps[0].Id, Status='In Progress', Priority='Normal'),
    new Task(Subject='SFTK CX Lead call', WhoId=leads[0].Id, Status='Completed', Priority='Low'),
    new Task(Subject='SFTK CX Case follow-up', WhatId=parentCase.Id, WhoId=ceo.Id, Status='Not Started', Priority='Normal')
  }, dmo);
  Database.insert(new List<Event>{
    new Event(Subject='SFTK CX Kickoff', WhoId=vp.Id, WhatId=opps[1].Id, StartDateTime=Datetime.now().addDays(7), EndDateTime=Datetime.now().addDays(7).addHours(1)),
    new Event(Subject='SFTK CX Site visit', WhatId=subs[0].Id, StartDateTime=Datetime.now().addDays(14), DurationInMinutes=90, IsAllDayEvent=false)
  }, dmo);

  // ── Assets with a parent asset ──
  Asset a1 = new Asset(Name='SFTK CX Widget #1', AccountId=hold.Id, ContactId=ceo.Id, Product2Id=prods[0].Id, Status='Installed', Quantity=1, Price=100, InstallDate=Date.today().addDays(-30), SerialNumber='SFTK-CX-0001');
  Database.insert(a1, dmo);
  Database.insert(new List<Asset>{
    new Asset(Name='SFTK CX Widget #1 — module A', AccountId=hold.Id, Product2Id=prods[0].Id, ParentId=a1.Id, Status='Installed', SerialNumber='SFTK-CX-0001-A'),
    new Asset(Name='SFTK CX Widget #2', AccountId=subs[0].Id, ContactId=team[0].Id, Product2Id=prods[0].Id, Status='Shipped', SerialNumber='SFTK-CX-0002')
  }, dmo);

  // ── Contract, Order, OrderItem ──
  Contract ctr = new Contract(AccountId=hold.Id, Status='Draft', StartDate=Date.today(), ContractTerm=12, Description='SFTK CX master agreement');
  Database.insert(ctr, dmo);
  Order ord = new Order(AccountId=hold.Id, Status='Draft', EffectiveDate=Date.today(), Pricebook2Id=stdPb, Description='SFTK CX first order');
  Database.insert(ord, dmo);
  Database.insert(new List<OrderItem>{
    new OrderItem(OrderId=ord.Id, PricebookEntryId=pbes[0].Id, Quantity=4, UnitPrice=100),
    new OrderItem(OrderId=ord.Id, PricebookEntryId=pbes[2].Id, Quantity=1, UnitPrice=100)
  }, dmo);

  // ── Person Accounts (if enabled) + a Case on the hidden Contact ──
  List<RecordType> prt = [SELECT Id FROM RecordType WHERE SObjectType = 'Account' AND IsPersonType = true AND IsActive = true LIMIT 1];
  if (!prt.isEmpty()) {
    List<Account> people = new List<Account>();
    people.add(new Account(RecordTypeId=prt[0].Id));
    people.add(new Account(RecordTypeId=prt[0].Id));
    people[0].put('FirstName', 'Person'); people[0].put('LastName', 'SFTK CX One'); people[0].put('PersonEmail', 'person.one@sftk-cx.example'); people[0].put('PersonMailingCountry', 'Israel');
    people[1].put('FirstName', 'Person'); people[1].put('LastName', 'SFTK CX Two'); people[1].put('PersonEmail', 'person.two@sftk-cx.example');
    Database.insert(people, dmo);
    Id pc = [SELECT PersonContactId FROM Account WHERE Id = :people[0].Id].PersonContactId;
    Database.insert(new Case(Subject='SFTK CX Person account case', AccountId=people[0].Id, ContactId=pc, Status='New', Origin='Web'), dmo);
    Database.insert(new Task(Subject='SFTK CX Person task', WhoId=pc, Status='Not Started', Priority='Normal'), dmo);
  }

  // ── Individual (if enabled) ──
  if (Schema.getGlobalDescribe().containsKey('Individual')) {
    SObject ind = Schema.getGlobalDescribe().get('Individual').newSObject();
    ind.put('LastName', 'SFTK CX Individual');
    Database.insert(ind, dmo);
    Contact c = new Contact(Id=ceo.Id); c.put('IndividualId', ind.Id); Database.update(c, dmo);
  }

  // ── Files: one on the holding account, one on a contact ──
  ContentVersion cv1 = new ContentVersion(Title='SFTK CX Contract scan', PathOnClient='sftk-cx-contract.txt', VersionData=Blob.valueOf('SFTK CX fixture file — contract\nline 2'), FirstPublishLocationId=hold.Id);
  ContentVersion cv2 = new ContentVersion(Title='SFTK CX Business card', PathOnClient='sftk-cx-card.txt', VersionData=Blob.valueOf('SFTK CX fixture file — card'), FirstPublishLocationId=ceo.Id);
  Database.insert(new List<ContentVersion>{cv1, cv2}, dmo);
  // the Holding file is also linked to the Europe account (shared file)
  Id doc1 = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv1.Id].ContentDocumentId;
  Database.insert(new ContentDocumentLink(ContentDocumentId=doc1, LinkedEntityId=subs[0].Id, ShareType='V', Visibility='AllUsers'), dmo);

  System.debug('SFTK CX fixture seeded');
} catch (Exception e) {
  Database.rollback(sp);
  System.debug('SFTK CX fixture FAILED: ' + e.getMessage() + ' @ ' + e.getStackTraceString());
  throw e;
}
