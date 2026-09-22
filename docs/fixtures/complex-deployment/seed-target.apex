// SFTK complex-deployment fixture — TARGET org. Creates the situations a real
// target has BEFORE a deployment: some records already there with different
// values (🟡 Changed), one that exists only here (🔵 In target only), a
// duplicate-name twin, the standard pricebook entries the line items need,
// and a Contact whose email collides with a source Contact (duplicate rule).
Database.DMLOptions dmo = new Database.DMLOptions(); dmo.DuplicateRuleHeader.allowSave = true; dmo.optAllOrNone = true;
// already-there parent with DRIFT: phone and revenue differ, no Description
Account hold = new Account(Name='SFTK CX Holding', Industry='Technology', Type='Customer - Direct', Rating='Warm', Website='https://sftk-cx.example', BillingCountry='Israel', BillingCity='Tel Aviv', Phone='+972-3-999-9999', AnnualRevenue=9000000, NumberOfEmployees=850);
Database.insert(hold, dmo);
// already-there child, in sync on every copied field except Title
Contact ceo = new Contact(FirstName='Dana', LastName='SFTK CX Levi', AccountId=hold.Id, Title='Chief Executive', Email='dana.levi@sftk-cx.example', Phone='+972-50-000-0001', MailingCountry='Israel', Birthdate=Date.newInstance(1980, 3, 14), LeadSource='Web');
Database.insert(ceo, dmo);
// exists ONLY in the target
Database.insert(new Account(Name='SFTK CX Only In Target', Industry='Media', BillingCity='Nowhere'), dmo);
// a duplicate-name twin on the TARGET side too (matching by Name becomes a coin flip)
Database.insert(new Account(Name='SFTK CX Duplicate Name', Industry='Energy', BillingCity='Target twin', AnnualRevenue=3), dmo);
// a Contact under a DIFFERENT account with the same name as a source Contact (link differs)
Account other = new Account(Name='SFTK CX Wrong Parent Co', Industry='Retail', Website='https://wrong-parent.example');
Database.insert(other, dmo);
Database.insert(new Contact(FirstName='Liam', LastName='SFTK CX Carter', AccountId=other.Id, Title='Country Manager', Email='liam.carter@sftk-cx.example'), dmo);
// products + STANDARD pricebook entries exist here (a real org has a catalogue); the custom pricebook does not
Id stdPb = [SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1].Id;
List<Product2> prods = new List<Product2>{
  new Product2(Name='SFTK CX Widget', ProductCode='SFTK-CX-W', IsActive=true, Family='Hardware'),
  new Product2(Name='SFTK CX Service Plan', ProductCode='SFTK-CX-S', IsActive=true, Family='Services')
};
Database.insert(prods, dmo);
List<PricebookEntry> pbes = new List<PricebookEntry>();
for (Product2 p : prods) pbes.add(new PricebookEntry(Pricebook2Id=stdPb, Product2Id=p.Id, UnitPrice=100, IsActive=true, UseStandardPrice=false));
Database.insert(pbes, dmo);
System.debug('SFTK CX target fixture seeded');
